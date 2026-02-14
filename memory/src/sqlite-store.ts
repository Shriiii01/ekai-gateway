import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
  EmbedFn,
  IngestComponents,
  IngestOptions,
  MemoryRecord,
  ProceduralMemoryRecord,
  SemanticMemoryRecord,
  QueryResult,
  SectorName,
  ConsolidationAction,
} from './types.js';
import { determineConsolidationAction } from './consolidation.js';
import { PBWM_SECTOR_WEIGHTS, scoreRowPBWM } from './scoring.js';
import { cosineSimilarity, DEFAULT_PROFILE, normalizeProfileSlug } from './utils.js';
import { filterAndCapWorkingMemory } from './wm.js';
import { SemanticGraphTraversal } from './semantic-graph.js';

const SECTORS: SectorName[] = ['episodic', 'semantic', 'procedural'];
const DEFAULT_WEIGHTS: Record<SectorName, number> = {
  episodic: 1,
  semantic: 1,
  procedural: 1,
};
const PER_SECTOR_K = 4;
const WORKING_MEMORY_CAP = 8;
const SECTOR_SCAN_LIMIT = 200; // simple scan instead of ANN for v0
const DEFAULT_RETRIEVAL_COUNT = 0;

export class SqliteMemoryStore {
  private db: Database.Database;
  private embed: EmbedFn;
  private now: () => number;
  public readonly graph: SemanticGraphTraversal;

  constructor(opts: { dbPath: string; embed: EmbedFn; now?: () => number }) {
    this.db = new Database(opts.dbPath);
    this.embed = opts.embed;
    this.now = opts.now ?? (() => Date.now());
    this.prepareSchema();
    this.graph = new SemanticGraphTraversal(this.db, this.now);
  }

  async ingest(components: IngestComponents, profile?: string, options?: IngestOptions): Promise<MemoryRecord[]> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const createdAt = this.now();
    const rows: MemoryRecord[] = [];
    const normalized = normalizeComponents(components);
    const source = options?.source;
    const dedup = options?.deduplicate === true;

    for (const [sector, content] of Object.entries(normalized) as Array<[SectorName, string | any]>) {
      // Skip empty content
      if (!content) continue;
      if (typeof content === 'string' && !content.trim()) continue;
      // For procedural, check trigger; for semantic, check if object has valid fields
      if (sector === 'procedural' && typeof content === 'object' && !content.trigger?.trim()) continue;
      if (sector === 'semantic' && typeof content === 'object') {
        // Skip if all semantic fields are empty
        if (!content.subject?.trim() && !content.predicate?.trim() && !content.object?.trim()) continue;
      }

      // Prepare content for embedding and storage
      let textToEmbed = '';
      let procRow: ProceduralMemoryRecord | undefined;
      let semanticRow: SemanticMemoryRecord | undefined;

      if (sector === 'procedural') {
        if (typeof content === 'string') {
          textToEmbed = content;
          procRow = {
            id: randomUUID(),
            trigger: content,
            profileId,
            goal: '',
            context: '',
            result: '',
            steps: [content],
            embedding: [], // Will be set later
            createdAt,
            lastAccessed: createdAt,
            source,
          };
        } else {
          textToEmbed = content.trigger;
          procRow = {
            id: randomUUID(),
            trigger: content.trigger,
            profileId,
            goal: content.goal ?? '',
            context: content.context ?? '',
            result: content.result ?? '',
            steps: Array.isArray(content.steps) ? content.steps : [],
            embedding: [], // Will be set later
            createdAt,
            lastAccessed: createdAt,
            source,
          };
        }
      } else {
        textToEmbed = content as string;
        if (sector === 'semantic') {
          if (typeof content === 'string') {
            // fallback: wrap string into a generic fact
            semanticRow = {
              id: randomUUID(),
              subject: 'User',
              predicate: 'statement',
              object: textToEmbed,
              profileId,
              embedding: [],
              validFrom: createdAt,
              validTo: null,
              createdAt,
              updatedAt: createdAt,
              strength: 1.0,
              source,
            };
          } else {
            // Ensure all three fields are populated for semantic triples
            const subject = content.subject?.trim() || 'User';
            const predicate = content.predicate?.trim() || 'hasProperty';
            const object = content.object?.trim();

            // Skip if object is missing (required for valid triple)
            if (!object) {
              continue;
            }

            semanticRow = {
              id: randomUUID(),
              subject,
              predicate,
              object,
              profileId,
              embedding: [],
              validFrom: createdAt,
              validTo: null,
              createdAt,
              updatedAt: createdAt,
              strength: 1.0,
              source,
            };
            // Embed the full triple to capture semantic relationships, not just the object
            textToEmbed = `${subject} ${predicate} ${object}`;
          }
        }
      }

      const embedding = await this.embed(textToEmbed, sector);

      if (sector === 'procedural' && procRow) {
        procRow.embedding = embedding;
        procRow.profileId = profileId;

        // Dedup: check for near-duplicate triggers
        if (dedup) {
          const existingDup = this.findDuplicateProcedural(embedding, profileId, 0.9);
          if (existingDup) {
            // Optionally add source attribution to existing record
            if (source && !existingDup.source) {
              this.setProceduralSource(existingDup.id, source);
            }
            rows.push({
              id: existingDup.id,
              sector,
              content: existingDup.trigger,
              embedding,
              profileId,
              createdAt: existingDup.createdAt,
              lastAccessed: existingDup.lastAccessed,
              source: existingDup.source ?? source,
            });
            continue;
          }
        }

        this.insertProceduralRow(procRow);
        rows.push({
          id: procRow.id,
          sector,
          content: procRow.trigger,
          embedding,
          profileId,
          createdAt,
          lastAccessed: createdAt,
          source,
        });
      } else if (sector === 'semantic' && semanticRow) {
        semanticRow.embedding = embedding;
        semanticRow.profileId = profileId;

        // Consolidation: find semantically similar predicates (0.9 threshold)
        const allFactsForSubject = this.findActiveFactsForSubject(
          semanticRow.subject,
          profileId
        );
        const matchingFacts = await this.findSemanticallyMatchingFacts(
          semanticRow.predicate,
          allFactsForSubject,
          0.9 // Semantic similarity threshold
        );
        const action = determineConsolidationAction(
          { subject: semanticRow.subject, predicate: semanticRow.predicate, object: semanticRow.object },
          matchingFacts
        );

        switch (action.type) {
          case 'merge':
            if (dedup) {
              // Document ingestion: skip strength bump, just add source attribution
              if (source) {
                this.setSemanticSource(action.targetId, source);
              }
            } else {
              // Chat ingestion: strengthen as before
              this.strengthenFact(action.targetId);
            }
            rows.push({
              id: action.targetId,
              sector,
              content: semanticRow.object,
              embedding,
              profileId,
              createdAt,
              lastAccessed: createdAt,
              eventStart: null,
              eventEnd: null,
              source,
            });
            break;

          case 'supersede':
            // Different object: close old fact, then insert new
            this.supersedeFact(action.targetId);
            // Fall through to insert

          case 'insert':
            // Insert new semantic triple
            this.insertSemanticRow(semanticRow);
            rows.push({
              id: semanticRow.id,
              sector,
              content: semanticRow.object,
              embedding,
              profileId,
              createdAt,
              lastAccessed: createdAt,
              eventStart: null,
              eventEnd: null,
              source,
            });
            break;
        }
      } else {
        // Episodic
        if (dedup) {
          const existingDup = this.findDuplicateMemory(embedding, sector as SectorName, profileId, 0.9);
          if (existingDup) {
            // Optionally add source attribution to existing record
            if (source && !existingDup.source) {
              this.setMemorySource(existingDup.id, source);
            }
            rows.push({
              id: existingDup.id,
              sector: sector as SectorName,
              content: existingDup.content,
              embedding,
              profileId,
              createdAt: existingDup.createdAt,
              lastAccessed: existingDup.lastAccessed,
              source: existingDup.source ?? source,
            });
            continue;
          }
        }

        const row: MemoryRecord = {
          id: randomUUID(),
          sector,
          content: textToEmbed,
          embedding,
          profileId,
          createdAt,
          lastAccessed: createdAt,
          eventStart: sector === 'episodic' ? createdAt : null,
          eventEnd: null,
          source,
        };
        this.insertRow(row);
        rows.push(row);
      }
    }
    return rows;
  }

  async query(
    queryText: string,
    profile?: string,
  ): Promise<{ workingMemory: QueryResult[]; perSector: Record<SectorName, QueryResult[]>; profileId: string }> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const queryEmbeddings: Record<SectorName, number[]> = {} as Record<SectorName, number[]>;
    for (const sector of SECTORS) {
      queryEmbeddings[sector] = await this.embed(queryText, sector);
    }

    const perSectorResults: Record<SectorName, QueryResult[]> = {
      episodic: [],
      semantic: [],
      procedural: [],
    };

    for (const sector of SECTORS) {
      const candidates =
        sector === 'procedural'
          ? this.getProceduralRows(profileId, SECTOR_SCAN_LIMIT).map((r) => ({
              id: r.id,
              sector: 'procedural' as SectorName,
              content: r.trigger,
              embedding: r.embedding,
              profileId: r.profileId,
              createdAt: r.createdAt,
              lastAccessed: r.lastAccessed,
              details: {
                trigger: r.trigger,
                goal: r.goal,
                context: r.context,
                result: r.result,
                steps: r.steps,
              },
            }))
          : sector === 'semantic'
            ? this.getSemanticRows(profileId, SECTOR_SCAN_LIMIT).map((r) => ({
                id: r.id,
                sector: 'semantic' as SectorName,
                content: `${r.subject} ${r.predicate} ${r.object}`,
                embedding: r.embedding ?? [],
                profileId: r.profileId,
                createdAt: r.createdAt,
                lastAccessed: r.updatedAt,
                details: {
                  subject: r.subject,
                  predicate: r.predicate,
                  object: r.object,
                  validFrom: r.validFrom,
                  validTo: r.validTo,
                },
              }))
          : this.getRowsForSector(sector, profileId, SECTOR_SCAN_LIMIT);
      const scored = candidates
        .filter((row) => cosineSimilarity(queryEmbeddings[sector], row.embedding) >= 0.2)
        .map((row) => scoreRowPBWM(row, queryEmbeddings[sector], PBWM_SECTOR_WEIGHTS[sector]))
        .sort((a, b) => b.gateScore - a.gateScore)
        .slice(0, PER_SECTOR_K)
        .map((row) => ({
          ...row,
          profileId,
          // propagate temporal fields for episodic; procedural has none
          eventStart: (row as any).eventStart ?? null,
          eventEnd: (row as any).eventEnd ?? null,
          details: (row as any).details,
        }));
      perSectorResults[sector] = scored;
      this.touchRows(scored.map((r) => r.id));
    }

    const workingMemory = filterAndCapWorkingMemory(perSectorResults, WORKING_MEMORY_CAP);
    this.bumpRetrievalCounts(workingMemory.map((r) => r.id));
    return { workingMemory, perSector: perSectorResults, profileId };
  }

  getSectorSummary(profile?: string): Array<{ sector: SectorName; count: number; lastCreatedAt: number | null }> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const rows = this.db
      .prepare(
        `select sector, count(*) as count, max(created_at) as lastCreatedAt
         from memory
         where profile_id = @profileId
         group by sector`,
      )
      .all({ profileId }) as Array<{ sector: SectorName; count: number; lastCreatedAt: number | null }>;

    const proceduralRow = this.db
      .prepare(
        `select 'procedural' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from procedural_memory
         where profile_id = @profileId`,
      )
      .get({ profileId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const semanticRow = this.db
      .prepare(
        `select 'semantic' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from semantic_memory
         where profile_id = @profileId`,
      )
      .get({ profileId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const defaults = SECTORS.map((s) => ({
      sector: s,
      count: 0,
      lastCreatedAt: null as number | null,
    }));

    const map = new Map(rows.map((r) => [r.sector, r]));
    if (proceduralRow) map.set('procedural', proceduralRow);
    if (semanticRow) map.set('semantic', semanticRow);
    return defaults.map((d) => map.get(d.sector) ?? d);
  }

  getRecent(profile: string | undefined, limit: number): (MemoryRecord & { details?: any })[] {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed, '{}' as details, event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount
         from memory
         where profile_id = @profileId
         union all
         select id, 'procedural' as sector, trigger as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                json_object('trigger', trigger, 'goal', goal, 'context', context, 'result', result, 'steps', json(steps)) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from procedural_memory
         where profile_id = @profileId
         union all
         select id, 'semantic' as sector, object as content, json('[]') as embedding, created_at as createdAt, updated_at as lastAccessed,
                json_object('subject', subject, 'predicate', predicate, 'object', object, 'validFrom', valid_from, 'validTo', valid_to, 'strength', strength, 'metadata', metadata) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from semantic_memory
         where profile_id = @profileId
           and (valid_to is null or valid_to > @now)
         order by createdAt desc
         limit @limit`,
      )
      .all({ profileId, limit, now: this.now() }) as Array<Omit<MemoryRecord, 'embedding' | 'profileId'> & { details: string }>;

    return rows.map((row) => {
      const parsed = {
        ...row,
        profileId,
        embedding: JSON.parse((row as any).embedding) as number[],
        details: row.details ? JSON.parse(row.details) : undefined,
        eventStart: row.eventStart ?? null,
        eventEnd: row.eventEnd ?? null,
      };
      
      // Ensure steps is always an array if it exists
      if (parsed.details && parsed.details.steps) {
        if (typeof parsed.details.steps === 'string') {
          try {
            parsed.details.steps = JSON.parse(parsed.details.steps);
          } catch {
            parsed.details.steps = [];
          }
        }
        if (!Array.isArray(parsed.details.steps)) {
          parsed.details.steps = [];
        }
      }
      
      return parsed;
    });
  }

  private insertRow(row: MemoryRecord) {
    this.db
      .prepare(
        `insert into memory (
          id, sector, content, embedding, created_at, last_accessed, event_start, event_end, retrieval_count, profile_id, source
        ) values (
          @id, @sector, @content, json(@embedding), @createdAt, @lastAccessed, @eventStart, @eventEnd, @retrievalCount, @profileId, @source
        )`,
      )
      .run({
        id: row.id,
        sector: row.sector,
        content: row.content,
        embedding: JSON.stringify(row.embedding),
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        eventStart: row.eventStart ?? null,
        eventEnd: row.eventEnd ?? null,
        retrievalCount: (row as any).retrievalCount ?? DEFAULT_RETRIEVAL_COUNT,
        profileId: row.profileId ?? DEFAULT_PROFILE,
        source: row.source ?? null,
      });
  }

  private insertProceduralRow(row: ProceduralMemoryRecord) {
    this.db
      .prepare(
        `insert into procedural_memory (
          id, trigger, goal, context, result, steps, embedding, created_at, last_accessed, profile_id, source
        ) values (
          @id, @trigger, @goal, @context, @result, json(@steps), json(@embedding), @createdAt, @lastAccessed, @profileId, @source
        )`,
      )
      .run({
        id: row.id,
        trigger: row.trigger,
        goal: row.goal ?? '',
        context: row.context ?? '',
        result: row.result ?? '',
        steps: JSON.stringify(row.steps),
        embedding: JSON.stringify(row.embedding),
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        profileId: row.profileId ?? DEFAULT_PROFILE,
        source: row.source ?? null,
      });
  }

  private insertSemanticRow(row: SemanticMemoryRecord) {
    this.db
      .prepare(
        `insert into semantic_memory (
          id, subject, predicate, object, valid_from, valid_to, created_at, updated_at, embedding, metadata, profile_id, strength, source
        ) values (
          @id, @subject, @predicate, @object, @validFrom, @validTo, @createdAt, @updatedAt, json(@embedding), json(@metadata), @profileId, @strength, @source
        )`,
      )
      .run({
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        validFrom: row.validFrom,
        validTo: row.validTo,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        embedding: JSON.stringify(row.embedding),
        metadata: row.metadata ? JSON.stringify(row.metadata) : null,
        profileId: row.profileId ?? DEFAULT_PROFILE,
        strength: row.strength ?? 1.0,
        source: row.source ?? null,
      });
  }

  /**
   * Find a near-duplicate in the memory table (episodic) by embedding similarity.
   */
  private findDuplicateMemory(
    embedding: number[],
    sector: SectorName,
    profileId: string,
    threshold: number,
  ): (MemoryRecord & { source?: string }) | null {
    const candidates = this.getRowsForSector(sector, profileId, SECTOR_SCAN_LIMIT);
    for (const row of candidates) {
      if (cosineSimilarity(embedding, row.embedding) >= threshold) {
        return row as MemoryRecord & { source?: string };
      }
    }
    return null;
  }

  /**
   * Find a near-duplicate procedural memory by trigger embedding similarity.
   */
  private findDuplicateProcedural(
    embedding: number[],
    profileId: string,
    threshold: number,
  ): (ProceduralMemoryRecord & { source?: string }) | null {
    const candidates = this.getProceduralRows(profileId, SECTOR_SCAN_LIMIT);
    for (const row of candidates) {
      if (cosineSimilarity(embedding, row.embedding) >= threshold) {
        return row as ProceduralMemoryRecord & { source?: string };
      }
    }
    return null;
  }

  private setMemorySource(id: string, source: string) {
    this.db.prepare('UPDATE memory SET source = @source WHERE id = @id').run({ id, source });
  }

  private setProceduralSource(id: string, source: string) {
    this.db.prepare('UPDATE procedural_memory SET source = @source WHERE id = @id').run({ id, source });
  }

  private setSemanticSource(id: string, source: string) {
    this.db.prepare('UPDATE semantic_memory SET source = @source WHERE id = @id').run({ id, source });
  }

  private getRowsForSector(sector: SectorName, profileId: string, limit: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount, profile_id as profileId, source
         from memory
         where sector = @sector and profile_id = @profileId
         order by last_accessed desc
         limit @limit`,
      )
      .all({ sector, limit, profileId }) as Array<Omit<MemoryRecord, 'embedding'>>;

    return rows.map((row) => ({
      ...row,
      embedding: JSON.parse((row as any).embedding) as number[],
    }));
  }

  private getSemanticRows(profileId: string, limit: number): SemanticMemoryRecord[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `select id, subject, predicate, object, valid_from as validFrom, valid_to as validTo,
                created_at as createdAt, updated_at as updatedAt, embedding, metadata, profile_id as profileId,
                strength
         from semantic_memory
         where profile_id = @profileId
           and (valid_to is null or valid_to > @now)
         order by strength desc, updated_at desc
         limit @limit`,
      )
      .all({ limit, profileId, now }) as any[];

    return rows.map((row) => ({
      ...row,
      embedding: JSON.parse((row as any).embedding) as number[],
      metadata: row.metadata ? JSON.parse((row as any).metadata) : undefined,
      strength: row.strength ?? 1.0,
    }));
  }

  private getProceduralRows(profileId: string, limit: number): ProceduralMemoryRecord[] {
    const rows = this.db
      .prepare(
        `select id, trigger, goal, context, result, steps, embedding, created_at as createdAt, last_accessed as lastAccessed, profile_id as profileId, source
         from procedural_memory
         where profile_id = @profileId
         order by last_accessed desc
         limit @limit`,
      )
      .all({ limit, profileId }) as Array<Omit<ProceduralMemoryRecord, 'embedding' | 'steps'>>;

    return rows.map((row) => ({
      ...row,
      steps: JSON.parse((row as any).steps) as string[],
      embedding: JSON.parse((row as any).embedding) as number[],
    }));
  }

  private touchRows(ids: string[]) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `update memory
         set last_accessed = ?
         where id in (${placeholders})`,
      )
      .run(this.now(), ...ids);
  }

  private prepareSchema() {
    this.db
      .prepare(
        `create table if not exists memory (
          id text primary key,
          sector text not null,
          content text not null,
          embedding json not null,
          created_at integer not null,
          last_accessed integer not null,
          event_start integer,
          event_end integer,
          retrieval_count integer not null default 0,
          profile_id text not null default '${DEFAULT_PROFILE}'
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_memory_sector on memory(sector)').run();
    this.db.prepare('create index if not exists idx_memory_last_accessed on memory(last_accessed)').run();

    this.db
      .prepare(
        `create table if not exists procedural_memory (
          id text primary key,
          trigger text not null,
          goal text,
          context text,
          result text,
          steps json not null,
          embedding json not null,
          created_at integer not null,
          last_accessed integer not null,
          profile_id text not null default '${DEFAULT_PROFILE}'
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_proc_last_accessed on procedural_memory(last_accessed)').run();

    this.db
      .prepare(
        `create table if not exists semantic_memory (
          id text primary key,
          subject text not null,
          predicate text not null,
          object text not null,
          valid_from integer not null,
          valid_to integer,
          created_at integer not null,
          updated_at integer not null,
          embedding json not null,
          metadata json,
          profile_id text not null default '${DEFAULT_PROFILE}'
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_semantic_subject_pred on semantic_memory(subject, predicate)').run();
    this.db.prepare('create index if not exists idx_semantic_object on semantic_memory(object)').run();
    this.ensureProfileColumns();
    this.ensureProfileIndexes();
    this.ensureProfilesTable();
    this.ensureStrengthColumn();
    this.ensureSourceColumn();
  }

  /**
   * Add strength column to semantic_memory if it doesn't exist.
   * Strength tracks evidence count from consolidation (starts at 1.0).
   */
  private ensureStrengthColumn() {
    const columns = this.db.prepare('PRAGMA table_info(semantic_memory)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'strength')) {
      this.db.prepare('ALTER TABLE semantic_memory ADD COLUMN strength REAL NOT NULL DEFAULT 1.0').run();
    }
    // Index for slot-based lookups (subject + predicate)
    this.db
      .prepare('CREATE INDEX IF NOT EXISTS idx_semantic_slot ON semantic_memory(subject, predicate, profile_id)')
      .run();
  }

  /**
   * Add source column to all 3 tables if it doesn't exist.
   * Stores the relative file path for document-ingested memories.
   */
  private ensureSourceColumn() {
    const tables = ['memory', 'procedural_memory', 'semantic_memory'];
    for (const table of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'source')) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN source TEXT DEFAULT NULL`).run();
      }
    }
  }

  /**
   * Find all active (non-expired) facts for a subject.
   * Used for semantic similarity matching during consolidation.
   */
  findActiveFactsForSubject(
    subject: string,
    profileId: string
  ): Array<{ id: string; predicate: string; object: string; updatedAt: number }> {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT id, predicate, object, updated_at as updatedAt
         FROM semantic_memory
         WHERE subject = @subject 
           AND profile_id = @profileId
           AND (valid_to IS NULL OR valid_to > @now)
         ORDER BY updated_at DESC`
      )
      .all({ subject, profileId, now }) as Array<{ id: string; predicate: string; object: string; updatedAt: number }>;
    return rows;
  }

  /**
   * Find facts with semantically similar predicates (using embeddings).
   * Returns facts where predicate similarity >= threshold.
   */
  async findSemanticallyMatchingFacts(
    newPredicate: string,
    existingFacts: Array<{ id: string; predicate: string; object: string; updatedAt: number }>,
    threshold: number = 0.9
  ): Promise<Array<{ id: string; object: string; updatedAt: number; similarity: number }>> {
    if (existingFacts.length === 0) return [];

    // Embed the new predicate
    const newPredicateEmbedding = await this.embed(newPredicate, 'semantic');
    
    // Get unique predicates to embed (avoid duplicate embedding calls)
    const uniquePredicates = [...new Set(existingFacts.map(f => f.predicate))];
    const predicateEmbeddings = new Map<string, number[]>();
    
    for (const pred of uniquePredicates) {
      predicateEmbeddings.set(pred, await this.embed(pred, 'semantic'));
    }

    // Filter facts by predicate similarity
    const matchingFacts: Array<{ id: string; object: string; updatedAt: number; similarity: number }> = [];
    
    for (const fact of existingFacts) {
      const factPredicateEmbedding = predicateEmbeddings.get(fact.predicate)!;
      const similarity = cosineSimilarity(newPredicateEmbedding, factPredicateEmbedding);
      
      if (similarity >= threshold) {
        matchingFacts.push({
          id: fact.id,
          object: fact.object,
          updatedAt: fact.updatedAt,
          similarity
        });
      }
    }

    // Sort by similarity desc, then by updatedAt desc
    matchingFacts.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return b.updatedAt - a.updatedAt;
    });

    return matchingFacts;
  }

  /**
   * Strengthen an existing semantic fact (merge operation).
   * Increases strength by delta and updates timestamp.
   */
  strengthenFact(id: string, delta: number = 1.0): void {
    this.db
      .prepare(
        `UPDATE semantic_memory 
         SET strength = strength + @delta, 
             updated_at = @now
         WHERE id = @id`
      )
      .run({ id, delta, now: this.now() });
  }

  /**
   * Supersede a semantic fact by closing its validity window.
   * The fact remains in the database for historical queries.
   */
  supersedeFact(id: string): void {
    this.db
      .prepare(
        `UPDATE semantic_memory 
         SET valid_to = @now,
             updated_at = @now
         WHERE id = @id`
      )
      .run({ id, now: this.now() });
  }

  /**
   * Backfills profile_id column for existing databases and creates profile-aware indexes.
   */
  private ensureProfileColumns() {
    const tables = ['memory', 'procedural_memory', 'semantic_memory'];
    for (const table of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const hasProfile = columns.some((c) => c.name === 'profile_id');
      if (!hasProfile) {
        this.db
          .prepare(`ALTER TABLE ${table} ADD COLUMN profile_id text not null default '${DEFAULT_PROFILE}'`)
          .run();
      }
    }
  }

  private ensureProfileIndexes() {
    this.db
      .prepare('create index if not exists idx_memory_profile_sector on memory(profile_id, sector, last_accessed)')
      .run();
    this.db
      .prepare('create index if not exists idx_proc_profile on procedural_memory(profile_id, last_accessed)')
      .run();
    this.db
      .prepare('create index if not exists idx_semantic_profile on semantic_memory(profile_id, updated_at)')
      .run();
  }

  private ensureProfilesTable() {
    this.db
      .prepare(
        `create table if not exists profiles (
          slug text primary key,
          created_at integer not null
        )`,
      )
      .run();

    this.ensureProfileExists(DEFAULT_PROFILE);

    // One-time backfill of existing profile ids into profiles table
    const now = this.now();
    const backfill = [
      'insert or ignore into profiles (slug, created_at) select distinct profile_id, @now from memory',
      'insert or ignore into profiles (slug, created_at) select distinct profile_id, @now from procedural_memory',
      'insert or ignore into profiles (slug, created_at) select distinct profile_id, @now from semantic_memory',
    ];
    for (const sql of backfill) {
      this.db.prepare(sql).run({ now });
    }
  }

  private ensureProfileExists(profileId: string) {
    this.db
      .prepare('insert or ignore into profiles (slug, created_at) values (@slug, @createdAt)')
      .run({ slug: profileId, createdAt: this.now() });
  }

  async updateById(id: string, content: string, sector?: SectorName, profile?: string): Promise<boolean> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    // First, get the existing record to preserve sector if not changing
    const existing = this.db
      .prepare('select sector from memory where id = ? and profile_id = ?')
      .get(id, profileId) as { sector: SectorName } | undefined;

    if (!existing) {
      return false;
    }

    const targetSector = sector ?? existing.sector;
    
    // Regenerate embedding with new content
    const embedding = await this.embed(content, targetSector);
    
    // Update the record
    const stmt = this.db.prepare(
      'update memory set content = ?, sector = ?, embedding = json(?), last_accessed = ? where id = ? and profile_id = ?'
    );
    const res = stmt.run(
      content,
      targetSector,
      JSON.stringify(embedding),
      this.now(),
      id,
      profileId,
    );
    
    return res.changes > 0;
  }

  deleteById(id: string, profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const res1 = this.db.prepare('delete from memory where id = ? and profile_id = ?').run(id, profileId);
    const res2 = this.db.prepare('delete from procedural_memory where id = ? and profile_id = ?').run(id, profileId);
    const res3 = this.db.prepare('delete from semantic_memory where id = ? and profile_id = ?').run(id, profileId);
    return (res1.changes ?? 0) + (res2.changes ?? 0) + (res3.changes ?? 0);
  }

  deleteAll(profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const res1 = this.db.prepare('delete from memory where profile_id = ?').run(profileId);
    const res2 = this.db.prepare('delete from procedural_memory where profile_id = ?').run(profileId);
    const res3 = this.db.prepare('delete from semantic_memory where profile_id = ?').run(profileId);
    return (res1.changes ?? 0) + (res2.changes ?? 0) + (res3.changes ?? 0);
  }

  deleteProfile(profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    if (profileId === DEFAULT_PROFILE) {
      throw new Error('cannot_delete_default_profile');
    }
    // Delete all memories for this profile
    const deletedCount = this.deleteAll(profileId);
    // Delete the profile itself from the profiles table
    const res = this.db.prepare('delete from profiles where slug = ?').run(profileId);
    return deletedCount;
  }

  deleteSemanticById(id: string, profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const res = this.db.prepare('delete from semantic_memory where id = ? and profile_id = ?').run(id, profileId);
    return res.changes ?? 0;
  }

  getAvailableProfiles(): string[] {
    const rows = this.db.prepare('select slug from profiles order by slug').all() as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
  }

  private bumpRetrievalCounts(ids: string[]) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `update memory
         set retrieval_count = retrieval_count + 1,
             last_accessed = ?
         where id in (${placeholders})`,
      )
      .run(this.now(), ...ids);
  }
}

function normalizeComponents(input: IngestComponents): Record<SectorName, string | any> {
  return {
    episodic: input.episodic ?? '',
    semantic: input.semantic ?? '',
    procedural: input.procedural ?? '',
  };
}
