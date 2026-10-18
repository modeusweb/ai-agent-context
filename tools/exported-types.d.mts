/**
 * Type declarations for `exported-types.mjs`.
 *
 * `tools/` is plain JavaScript and is deliberately outside the TypeScript
 * program, so this sibling declaration is what lets a `.ts` test import the
 * helper without pulling the whole directory into type checking.
 */

/** Names exported by a declaration file that have no runtime binding. */
export declare function exportedTypeNames(declarationPath: string): string[];