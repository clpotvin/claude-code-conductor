import { simpleGit, SimpleGit } from "simple-git";
import { GIT_CHECKPOINT_PREFIX } from "./constants.js";

export class GitManager {
  private git: SimpleGit;

  constructor(projectDir: string) {
    this.git = simpleGit(projectDir);
  }

  /**
   * Create a new branch from the current HEAD.
   */
  async createBranch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
  }

  /**
   * Checkout an existing branch.
   */
  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  /**
   * Get the name of the currently checked-out branch.
   */
  async getCurrentBranch(): Promise<string> {
    const result = await this.git.revparse(["--abbrev-ref", "HEAD"]);
    return result.trim();
  }

  /**
   * Get the full SHA of the current HEAD commit.
   */
  async getHeadSha(): Promise<string> {
    const result = await this.git.revparse(["HEAD"]);
    return result.trim();
  }

  /**
   * Check if the repository is in a detached HEAD state.
   */
  async isDetachedHead(): Promise<boolean> {
    const branch = await this.getCurrentBranch();
    return branch === "HEAD";
  }

  /**
   * Create a checkpoint commit: stage all changes and commit with
   * a checkpoint-prefixed tag message.
   */
  async checkpoint(tag: string): Promise<void> {
    await this.git.add("-A");
    await this.git.commit(`${GIT_CHECKPOINT_PREFIX}${tag}`);
  }

  /**
   * Stage all changes and commit with the given message.
   */
  async commit(message: string): Promise<void> {
    await this.git.add("-A");
    await this.git.commit(message);
  }

  /**
   * Get the diff from a base branch to the current HEAD.
   * Returns the full diff output as a string.
   */
  async getDiff(base: string): Promise<string> {
    return await this.git.diff([`${base}...HEAD`]);
  }

  /**
   * Get the list of files changed between a base branch and HEAD.
   */
  async getChangedFiles(base: string): Promise<string[]> {
    const result = await this.git.diff(["--name-only", `${base}...HEAD`]);
    return result
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  /**
   * Pull with rebase from the remote tracking branch.
   */
  async pullRebase(): Promise<void> {
    await this.git.pull(["--rebase"]);
  }
}
