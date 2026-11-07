import { loadWorkspaceFiles, MAX_WORKSPACE_ARCHIVE_CONTENT, MAX_WORKSPACE_FILES, type WorkspaceImportFile } from './workspaceArchive';
import type { Configuration } from './types';

export type { WorkspaceImportFile } from './workspaceArchive';
export const MAX_WORKSPACE_FOLDER_SIZE = MAX_WORKSPACE_ARCHIVE_CONTENT;
export const MAX_WORKSPACE_FOLDER_FILES = MAX_WORKSPACE_FILES;

/** Paths are relative to the selected folder, with workspace.json at its root. */
export function loadWorkspaceFolder(files: readonly WorkspaceImportFile[]): Configuration {
  return loadWorkspaceFiles(files);
}
