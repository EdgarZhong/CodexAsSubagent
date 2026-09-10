import { realpath, stat } from 'node:fs/promises';

import {
  ThreadWorkspaceMismatchError,
  WorkspaceUnavailableError,
} from '../shared/errors.mjs';

function threadWorkspace(thread) {
  return thread?.cwd
    ?? thread?.workingDirectory
    ?? thread?.workspace
    ?? thread?.safety?.cwd
    ?? null;
}

export class WorkspaceGuard {
  constructor({ realpathImpl = realpath, statImpl = stat } = {}) {
    this.realpathImpl = realpathImpl;
    this.statImpl = statImpl;
  }

  async resolve(cwd) {
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      throw new WorkspaceUnavailableError('A non-empty workspace path is required.');
    }
    let canonical;
    try {
      canonical = await this.realpathImpl(cwd);
      const info = await this.statImpl(canonical);
      if (!info.isDirectory()) {
        throw new Error('Workspace path is not a directory.');
      }
    } catch (error) {
      if (error instanceof WorkspaceUnavailableError) {
        throw error;
      }
      throw new WorkspaceUnavailableError(`Workspace is unavailable: ${cwd}`);
    }
    return canonical;
  }

  async assertThreadWorkspace(thread, workspace) {
    const canonicalWorkspace = await this.resolve(workspace);
    const storedWorkspace = threadWorkspace(thread);
    if (typeof storedWorkspace !== 'string' || storedWorkspace.trim().length === 0) {
      throw new ThreadWorkspaceMismatchError('Thread has no verifiable workspace metadata.');
    }

    let canonicalThreadWorkspace;
    try {
      canonicalThreadWorkspace = await this.realpathImpl(storedWorkspace);
      const info = await this.statImpl(canonicalThreadWorkspace);
      if (!info.isDirectory()) {
        throw new Error('Thread workspace path is not a directory.');
      }
    } catch {
      throw new ThreadWorkspaceMismatchError('Thread workspace cannot be canonicalized.');
    }
    if (canonicalThreadWorkspace !== canonicalWorkspace) {
      throw new ThreadWorkspaceMismatchError('Thread workspace does not match the current workspace.');
    }
    return canonicalWorkspace;
  }

  static async resolve(cwd) {
    return await new WorkspaceGuard().resolve(cwd);
  }

  static async assertThreadWorkspace(thread, workspace) {
    return await new WorkspaceGuard().assertThreadWorkspace(thread, workspace);
  }
}
