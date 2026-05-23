'use strict';
/**
 * S# Semantic Analyzer
 *
 * Static variable layout rule:
 *   Static vars occupy zp slots 0..N-1, allocated first.
 *   All other vars (globals, params, locals) follow from slot N onward.
 *   The runtime pre-loads static values into those slots before running
 *   the script. Bytecode always addresses them as plain Z# — no special
 *   addressing mode needed.
 */

class SemanticError extends Error {
  constructor(msg, tok, file) {
    const loc = tok ? `${file}:${tok.line}:${tok.col}: ` : `${file}: `;
    super(`${loc}Semantic error: ${msg}`);
  }
}

class SymbolTable {
  constructor() {
    this.scopes   = [{}];  // scope stack
    this.functions = {};   // name -> { params, retType, isInline }
    this.structs   = {};   // name -> { fields }
    this.globals   = {};   // name -> { type, slot, isConst }
    this.zpIndex   = 0;    // next free zp slot
    this.zpMap     = {};   // varName -> slot

    // Ordered list of static variables in slot order (slots 0, 1, 2, ...)
    // Each entry: { name, type, initValue, slot }
    this.statics   = [];
  }

  pushScope() { this.scopes.push({}); }
  popScope()  { this.scopes.pop(); }

  declare(name, info) {
    this.scopes[this.scopes.length - 1][name] = info;
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i][name] !== undefined) return this.scopes[i][name];
    }
    return null;
  }

  /** Allocate the next zp slot for an ordinary variable. */
  allocZP(name, size = 1) {
    const slot = this.zpIndex;
    this.zpMap[name] = slot;
    this.zpIndex += size;
    return slot;
  }

  getZP(name) { return this.zpMap[name]; }

  /**
   * Reserve a zp slot for a static variable.
   * MUST be called before any allocZP calls so statics always sit at
   * the lowest indices (0, 1, 2, ...).
   */
  allocStatic(name, type, initValue = 0) {
    const slot = this.allocZP(name);  // just a normal zp alloc
    this.statics.push({ name, type, initValue, slot });
    return slot;
  }
}

// Helper: extract a literal init value from an AST node, or return a default.
function literalValue(node, fallback = 0) {
  if (!node) return fallback;
  switch (node.kind) {
    case 'IntLit':    return node.value;
    case 'FloatLit':  return node.value;
    case 'StringLit': return node.value;
    case 'BoolLit':   return node.value ? 1 : 0;
    default:          return fallback;
  }
}

class SemanticAnalyzer {
  constructor(filename = '<stdin>') {
    this.file = filename;
    this.symbolTable = new SymbolTable();
    this.currentFn  = null;
    this.loopDepth  = 0;
  }

  error(msg, tok) { throw new SemanticError(msg, tok, this.file); }

  analyze(ast) {
    // Pass 1a: register statics first so they get the lowest zp slots
    for (const decl of ast.decls) {
      if (decl.kind === 'VarDecl' && decl.isStatic) this.registerStatic(decl);
    }
    // Pass 1b: register everything else
    for (const decl of ast.decls) {
      if (decl.kind === 'StructDecl') this.registerStruct(decl);
      if (decl.kind === 'FnDecl')     this.registerFn(decl);
      if (decl.kind === 'VarDecl' && !decl.isStatic) this.registerGlobal(decl);
    }
    // Pass 2: analyze bodies
    for (const decl of ast.decls) {
      if (decl.kind === 'FnDecl') this.analyzeFn(decl);
      if (decl.kind === 'VarDecl' && !decl.isStatic) this.analyzeExprIfPresent(decl.init);
    }
  }

  registerStatic(decl) {
    const initValue = literalValue(decl.init);
    const slot = this.symbolTable.allocStatic(decl.name, decl.type, initValue);
    decl._slot = slot;
    this.symbolTable.globals[decl.name] = { type: decl.type, slot, isConst: decl.isConst };
    // Declare in global scope so lookup() finds it
    this.symbolTable.declare(decl.name, { type: decl.type, slot, isConst: decl.isConst, kind: 'static' });
  }

  registerGlobal(decl) {
    const slot = this.symbolTable.allocZP(decl.name);
    decl._slot = slot;
    this.symbolTable.globals[decl.name] = { type: decl.type, slot, isConst: decl.isConst };
    this.symbolTable.declare(decl.name, { type: decl.type, slot, isConst: decl.isConst, kind: 'var' });
  }

  registerStruct(decl) {
    if (this.symbolTable.structs[decl.name])
      this.error(`Duplicate struct '${decl.name}'`, decl.tok);
    this.symbolTable.structs[decl.name] = { fields: decl.fields };
  }

  registerFn(decl) {
    if (this.symbolTable.functions[decl.name])
      this.error(`Duplicate function '${decl.name}'`, decl.tok);
    this.symbolTable.functions[decl.name] = {
      params: decl.params, retType: decl.retType, isInline: decl.isInline,
    };
  }

  analyzeFn(decl) {
    this.currentFn = decl;
    this.symbolTable.pushScope();
    for (const param of decl.params) {
      const slot = this.symbolTable.allocZP(param.name);
      this.symbolTable.declare(param.name, { type: param.type, slot, kind: 'param' });
      param._slot = slot;
    }
    this.analyzeBlock(decl.body);
    this.symbolTable.popScope();
    this.currentFn = null;
  }

  analyzeBlock(block) {
    this.symbolTable.pushScope();
    for (const stmt of block.stmts) this.analyzeStmt(stmt);
    this.symbolTable.popScope();
  }

  analyzeStmt(stmt) {
    switch (stmt.kind) {
      case 'VarDecl': {
        if (stmt.isStatic) {
          // Local static: still a zp slot, but listed in statics header
          // Only valid inside functions as a persistent local
          const initValue = literalValue(stmt.init);
          const slot = this.symbolTable.allocStatic(stmt.name, stmt.type, initValue);
          stmt._slot = slot;
          this.symbolTable.declare(stmt.name, { type: stmt.type, slot, isConst: stmt.isConst, kind: 'static' });
        } else {
          const slot = this.symbolTable.allocZP(stmt.name);
          stmt._slot = slot;
          this.symbolTable.declare(stmt.name, { type: stmt.type, slot, isConst: stmt.isConst, kind: 'var' });
        }
        if (stmt.init && !stmt.isStatic) this.analyzeExpr(stmt.init);
        break;
      }
      case 'IfStmt':
        this.analyzeExpr(stmt.cond);
        this.analyzeBlock(stmt.then);
        if (stmt.els) {
          if (stmt.els.kind === 'IfStmt') this.analyzeStmt(stmt.els);
          else this.analyzeBlock(stmt.els);
        }
        break;
      case 'WhileStmt':
        this.analyzeExpr(stmt.cond);
        this.loopDepth++;
        this.analyzeBlock(stmt.body);
        this.loopDepth--;
        break;
      case 'ForStmt':
        this.symbolTable.pushScope();
        if (stmt.init) this.analyzeStmt(stmt.init);
        if (stmt.cond) this.analyzeExpr(stmt.cond);
        if (stmt.post) this.analyzeExpr(stmt.post);
        this.loopDepth++;
        this.analyzeBlock(stmt.body);
        this.loopDepth--;
        this.symbolTable.popScope();
        break;
      case 'ReturnStmt':
        if (!this.currentFn) this.error('return outside function', stmt.tok);
        if (stmt.value) this.analyzeExpr(stmt.value);
        break;
      case 'BreakStmt':
        if (this.loopDepth === 0) this.error('break outside loop', stmt.tok);
        break;
      case 'ContinueStmt':
        if (this.loopDepth === 0) this.error('continue outside loop', stmt.tok);
        break;
      case 'ExprStmt':   this.analyzeExpr(stmt.expr); break;
      case 'Block':      this.analyzeBlock(stmt); break;
      case 'WaitStmt':   this.analyzeExpr(stmt.expr); break;
      case 'BroadcastStmt':
      case 'AsmStmt':    break;
      default: break;
    }
  }

  analyzeExpr(expr) {
    if (!expr) return;
    switch (expr.kind) {
      case 'Ident': {
        const sym = this.symbolTable.lookup(expr.name);
        const fnInfo = this.symbolTable.functions[expr.name];
        if (!sym && !fnInfo)
          this.error(`Undefined identifier '${expr.name}'`, expr.tok);
        if (sym) { expr._slot = sym.slot; expr._type = sym.type; }
        // If it resolves to a function (and isn't also a variable), tag it
        if (fnInfo && !sym) { expr._isFnRef = true; expr._fnName = expr.name; }
        break;
      }
      case 'Assign':   this.analyzeExpr(expr.target); this.analyzeExpr(expr.value); break;
      case 'BinOp':    this.analyzeExpr(expr.left);   this.analyzeExpr(expr.right); break;
      case 'UnOp':
      case 'PostOp':   this.analyzeExpr(expr.operand); break;
      case 'Call': {
        const callee = expr.callee;
        if (callee.kind === 'Ident') {
          const fnInfo = this.symbolTable.functions[callee.name];
          const sym    = this.symbolTable.lookup(callee.name);
          if (fnInfo && !sym) {
            // Direct named call
            expr._fnInfo = fnInfo;
            expr._directCall = true;
          } else if (sym) {
            // Indirect call through a variable holding a fn pointer
            expr._indirect = true;
            this.analyzeExpr(callee); // sets callee._slot
          } else {
            this.error(`Undefined function '${callee.name}'`, expr.tok);
          }
        } else {
          // Indirect call through entity ref, self ref, etc. — handled in codegen
          expr._indirect = true;
          this.analyzeExpr(callee);
        }
        for (const arg of expr.args) this.analyzeExpr(arg);
        break;
      }
      case 'Member':   this.analyzeExpr(expr.obj); break;
      case 'Index':    this.analyzeExpr(expr.base); this.analyzeExpr(expr.index); break;
      case 'NewExpr':  for (const a of expr.args) this.analyzeExpr(a); break;
      case 'SenseExpr':
        // expr.index is now a [category, name] path array, not an AST node
        // Nothing to resolve at semantic time — codegen handles the lookup
        break;
      case 'CastExpr': this.analyzeExpr(expr.expr); break;
      case 'IntLit': case 'FloatLit': case 'StringLit':
      case 'BoolLit': case 'NullLit': case 'EntityRef': case 'SelfRef':
      case 'FnRef':   break;
      default: break;
    }
  }

  analyzeExprIfPresent(expr) { if (expr) this.analyzeExpr(expr); }
}

module.exports = { SemanticAnalyzer };
