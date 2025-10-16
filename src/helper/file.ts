import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads a file synchronously and returns the contents as a string.
 *
 * Examples:
 * Read a file relative to the current module:
 * ```ts
 * import { readFileSync } from './file';
 * const __dirname = path.dirname(fileURLToPath(import.meta.url));
 * const fileContents = readFileSync('./file.txt', __dirname);
 * ```
 *
 * Read a file relative to the current working directory:
 * ```ts
 * import { readFileSync } from './file';
 * const fileContents = readFileSync('src/helper/file.txt');
 * ```
 *
 * @param filePath The path to the file to read
 * @param relativeTo The path to resolve the file path against, if this is not
 * provided, the current working directory is used
 * @returns The contents of the file as a string
 * @throws Error if the file cannot be read
 */
export function readFileSync(filePath: string, relativeTo?: string): string {
  // Get the directory name of the current module
  let absolutePath: string;

  // If the path is relative to a file, use the provided relativeTo path
  if (relativeTo) {
    absolutePath = path.resolve(relativeTo, filePath);
  } else {
    // Otherwise, use the CWD
    absolutePath = path.resolve(process.cwd(), filePath);
  }

  // Read the file contents synchronously
  return fs.readFileSync(absolutePath, 'utf-8');
}

export default readFileSync;
