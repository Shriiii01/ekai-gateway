import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required');
  process.exit(1);
}

export const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:4005';
export const PORT = parseInt(process.env.OPENROUTER_PORT || '4010', 10);
