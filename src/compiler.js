#!/usr/bin/env node
/**
 * S# Compiler
 * Compiles S# source to S# Runtime pseudobytecode.
 * Usage: node compiler.js <input.sl> [-o output.sbc] [--verbose]
 */

const fs   = require('fs');
const path = require('path');
const { Lexer }            = require('./lexer');
const { Parser }           = require('./parser');
const { SemanticAnalyzer } = require('./semantic');
const { CodeGenerator }    = require('./codegen');

/**
 * Recursively resolve imports, returning a single merged source string.
 * Cycles are detected via the `seen` set of resolved absolute paths.
 */
function resolveImports(source, filePath, seen = new Set()) {
  const dir = path.dirname(filePath);
  const abs = path.resolve(filePath);
  if (seen.has(abs)) return ''; // already included — skip silently
  seen.add(abs);

  // Quick pre-scan for import statements using the lexer
  const lexer = new Lexer(source, filePath);
  const tokens = lexer.tokenize();

  let result = '';
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    // import "path/to/file.sl";
    if (t.type === 'KEYWORD' && t.value === 'import') {
      const pathTok = tokens[i + 1];
      // i+2 should be semicolon
      if (pathTok && pathTok.type === 'STRING') {
        const importPath = path.resolve(dir, pathTok.value);
        if (!fs.existsSync(importPath)) {
          throw new Error(`${filePath}:${t.line}:${t.col}: Import error: file not found '${pathTok.value}'`);
        }
        const importedSource = fs.readFileSync(importPath, 'utf8');
        // Recursively resolve imports in the imported file
        result += resolveImports(importedSource, importPath, seen) + '\n';
        i += 3; // skip: import "path" ;
        continue;
      }
    }
    i++;
  }

  // Append this file's source (minus import lines, since we prepended them)
  // Simple approach: strip import lines from source and append the rest
  const stripped = source.replace(/^\s*import\s+"[^"]*"\s*;/gm, '');
  result += stripped;
  return result;
}

function compile(source, options = {}) {
  const { verbose = false, filename = '<stdin>' } = options;

  try {
    // Phase 0: Resolve imports
    if (verbose) console.error('[0/4] Resolving imports...');
    const merged = resolveImports(source, path.resolve(filename));
    if (verbose) console.error(`      ${merged.split('\n').length} lines after merge`);

    // Phase 1: Lexing
    if (verbose) console.error('[1/4] Lexing...');
    const lexer = new Lexer(merged, filename);
    const tokens = lexer.tokenize();
    if (verbose) console.error(`      ${tokens.length} tokens`);

    // Phase 2: Parsing
    if (verbose) console.error('[2/4] Parsing...');
    const parser = new Parser(tokens, filename, merged);
    const ast = parser.parse();
    if (verbose) console.error(`      AST built`);

    // Phase 3: Semantic Analysis
    if (verbose) console.error('[3/4] Semantic analysis...');
    const analyzer = new SemanticAnalyzer(filename);
    analyzer.analyze(ast);
    if (verbose) console.error(`      Symbols resolved`);

    // Phase 4: Code Generation
    if (verbose) console.error('[4/4] Generating bytecode...');
    const codegen = new CodeGenerator(analyzer.symbolTable);
    const output = codegen.generate(ast);
    if (verbose) {
      const bytecode = output.split('\n')[1] || '';
      console.error(`      ${bytecode.length} chars of bytecode`);
    }

    return { success: true, bytecode: output };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// CLI entry
if (require.main === module) {
  const args = process.argv.slice(2);
  let inputFile = null;
  let outputFile = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') outputFile = args[++i];
    else if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    else inputFile = args[i];
  }

  if (!inputFile) {
    console.error('Usage: node compiler.js <input.sl> [-o output.sbc] [--verbose]');
    process.exit(1);
  }

  const source = fs.readFileSync(inputFile, 'utf8');
  const result = compile(source, { verbose, filename: inputFile });

  if (!result.success) {
    console.error(`Compilation error:\n${result.error}`);
    process.exit(1);
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, result.bytecode);
    if (verbose) console.error(`Written to ${outputFile}`);
  } else {
    process.stdout.write(result.bytecode);
  }
}

module.exports = { compile };
