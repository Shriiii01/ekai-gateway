import { ReactNode } from 'react';
import { useCopy } from '@/hooks/useCopy';
import { API_CONFIG } from '@/lib/constants';

const API_BASE_URL = API_CONFIG.BASE_URL;
const DASHBOARD_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

interface FirstRunModalProps {
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
  children?: ReactNode;
}

export default function FirstRunModal({ open, onClose, onRefresh, children }: FirstRunModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full p-8 relative border border-gray-200">
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute right-4 top-4 text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>
        <div className="mb-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-900">
            <span>🧭</span>
            <span>First run guide</span>
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 mt-3">Get started with the gateway</h2>
          <p className="text-gray-600 mt-2">
            Configure your .env, start the gateway, then hit it with any OpenAI- or Anthropic-compatible client such as Claude Code, Codex, or any API client. Refresh once you send your first call.
          </p>
        </div>

        <div className="space-y-3">
          <Step
            number={1}
            title="Configure environment"
            commands={['cp .env.example .env']}
          >
            Copy `.env.example` to `.env` and add at least one provider key (OpenAI, Anthropic, Gemini, xAI, OpenRouter, etc.).
          </Step>
          <Step
            number={2}
            title="Restart the services"
          >
            Restart the services to ensure the gateway is running on port 3001.
          </Step>
          <Step number={3} title="Send your first request">
            Point your client to the gateway base URL shown below and make a test chat completion. Come back and refresh to see usage.
          </Step>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <InfoCard label="Gateway base URL" value={API_BASE_URL} />
          <InfoCard label="Dashboard URL" value={DASHBOARD_URL} />
        </div>

        {children}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900"
          >
            Dismiss
          </button>
          <button
            onClick={onRefresh}
            className="px-4 py-2 text-sm font-semibold text-white rounded-md shadow"
            style={{ backgroundColor: '#004f4f' }}
          >
            Refresh after first call
          </button>
        </div>
      </div>
    </div>
  );
}

interface StepProps {
  number: number;
  title: string;
  children: ReactNode;
  commands?: string[];
}

function Step({ number, title, children, commands = [] }: StepProps) {
  return (
    <div className="flex gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-900 text-white flex items-center justify-center font-semibold text-sm shadow-sm">
        {number}
      </div>
      <div className="flex-1 space-y-2 min-w-0">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-600">{children}</p>
        {commands.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {commands.map(cmd => (
              <CommandSnippet key={cmd} command={cmd} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommandSnippet({ command }: { command: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-white border border-gray-200 shadow-sm group">
      <code className="text-sm font-mono text-gray-900">{command}</code>
      <button
        type="button"
        onClick={() => copy(command)}
        className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded transition-colors"
        aria-label="Copy command"
        title={copied ? "Copied!" : "Copy to clipboard"}
      >
        {copied ? (
          <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-lg border border-gray-200 bg-white shadow-sm flex justify-between items-center">
      <div className="text-sm text-gray-600">{label}</div>
      <div className="text-sm font-semibold text-gray-900 font-mono">{value}</div>
    </div>
  );
}
