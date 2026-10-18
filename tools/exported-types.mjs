/**
 * The type-only exports of a package, read through the TypeScript compiler.
 *
 * The API lock records `Object.keys(await import(entry))`, which sees values at
 * runtime. A type, an interface, a class used only as a type — none of those
 * exist once the module is loaded, so renaming or removing one left the lock
 * unchanged and CI green. The lock claimed to record every exported symbol, and
 * for roughly half of them it did not.
 *
 * The compiler is the right instrument because it resolves `export *` chains and
 * type re-exports for us; matching names out of the `.d.ts` with a regular
 * expression would report the shapes that happen to be written in this project
 * rather than the shapes the package actually exports.
 */
import ts from 'typescript';

/**
 * Names exported by a declaration file that have no runtime binding.
 *
 * @param {string} declarationPath absolute path to a `.d.ts` entry point
 * @returns {string[]} sorted names
 */
export function exportedTypeNames(declarationPath) {
  const program = ts.createProgram([declarationPath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const source = program.getSourceFile(declarationPath);
  if (source === undefined) throw new Error(`declaration file not found in program: ${declarationPath}`);

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`not a module: ${declarationPath}`);

  const names = [];
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    // `export { X } from './y'` and `export type { X } from './y'` both produce an
    // alias, so an alias cannot be read as "this is a value". Resolve it first
    // and ask what it actually points at.
    let target = symbol;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        target = checker.getAliasedSymbol(symbol);
      } catch {
        // An alias the checker cannot follow tells us nothing; keep the original.
      }
    }
    // A symbol with a value declaration is already covered by the runtime lock;
    // listing it twice would make the diff on every release unreadable.
    const hasValue = target.valueDeclaration !== undefined || (target.flags & ts.SymbolFlags.Value) !== 0;
    if (hasValue) continue;
    names.push(symbol.getName());
  }
  return [...new Set(names)].sort();
}