import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find project root by looking for package.json (works in both dev and prod)
function findProjectRoot(startPath: string): string {
  let currentPath = startPath;
  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json')) && 
        existsSync(join(currentPath, '.env.example'))) {
      return currentPath;
    }
    currentPath = dirname(currentPath);
  }
  // Fallback to process.cwd() if not found
  return process.cwd();
}

// Load environment exactly once for any module that imports config
const projectRoot = findProjectRoot(__dirname);
dotenv.config({ path: join(projectRoot, '.env') });

// Export normalized configuration values
// NOTE: These are deprecated - use getConfig() from app-config.ts instead
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const SERVICE_NAME = 'ekai-gateway';
export const SERVICE_VERSION = process.env.npm_package_version || 'dev';

