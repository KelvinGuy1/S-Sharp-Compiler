'use strict';
/**
 * S# Parser
 * Recursive-descent parser producing an AST.
 *
 * Grammar (simplified):
 *   program       = topLevel*
 *   topLevel      = structDecl | fnDecl | varDecl | importDecl
 *   structDecl    = 'struct' IDENT '{' fieldDecl* '}'
 *   fnDecl        = 'fn' IDENT '(' params ')' ':' type block
 *   block         = '{' stmt* '}'
 *   stmt          = varDecl | assignStmt | ifStmt | whileStmt | forStmt
 *                 | returnStmt | breakStmt | continueStmt | exprStmt
 *                 | asmStmt | broadcastStmt | waitStmt | allocStmt | freeStmt
 *   expr          = assignment
 */

const { TT } = require('./lexer');

class ParseError extends Error {
  constructor(msg, token, file) {
    super(`${file}:${token.line}:${token.col}: Parse error: ${msg} (got ${token.type} '${token.value}')`);
    this.token = token;
  }
}

// ─── AST node constructors ─────────────────────────────────────────────────

const N = {
  Program:      (decls)                   => ({ kind: 'Program', decls }),
  Import:       (path, tok)               => ({ kind: 'Import', path, tok }),
  StructDecl:   (name, fields, tok)       => ({ kind: 'StructDecl', name, fields, tok }),
  FieldDecl:    (name, type, tok)         => ({ kind: 'FieldDecl', name, type, tok }),
  FnDecl:       (name, params, retType, body, isInline, isStatic, tok) =>
                                             ({ kind: 'FnDecl', name, params, retType, body, isInline, isStatic, tok }),
  Param:        (name, type, tok)         => ({ kind: 'Param', name, type, tok }),
  VarDecl:      (name, type, init, isConst, isStatic, tok) =>
                                             ({ kind: 'VarDecl', name, type, init, isConst, isStatic, tok }),
  Block:        (stmts, tok)              => ({ kind: 'Block', stmts, tok }),
  IfStmt:       (cond, then, els, tok)    => ({ kind: 'IfStmt', cond, then, els, tok }),
  WhileStmt:    (cond, body, tok)         => ({ kind: 'WhileStmt', cond, body, tok }),
  ForStmt:      (init, cond, post, body, tok) =>
                                             ({ kind: 'ForStmt', init, cond, post, body, tok }),
  ReturnStmt:   (value, tok)              => ({ kind: 'ReturnStmt', value, tok }),
  BreakStmt:    (tok)                     => ({ kind: 'BreakStmt', tok }),
  ContinueStmt: (tok)                     => ({ kind: 'ContinueStmt', tok }),
  ExprStmt:     (expr, tok)               => ({ kind: 'ExprStmt', expr, tok }),
  AsmStmt:      (code, tok)               => ({ kind: 'AsmStmt', code, tok }),
  BroadcastStmt:(msg, tok)               => ({ kind: 'BroadcastStmt', msg, tok }),
  WaitStmt:     (expr, tok)              => ({ kind: 'WaitStmt', expr, tok }),

  // Expressions
  Assign:       (target, op, value, tok) => ({ kind: 'Assign', target, op, value, tok }),
  BinOp:        (op, left, right, tok)   => ({ kind: 'BinOp', op, left, right, tok }),
  UnOp:         (op, operand, tok)       => ({ kind: 'UnOp', op, operand, tok }),
  PostOp:       (op, operand, tok)       => ({ kind: 'PostOp', op, operand, tok }),
  Call:         (callee, args, tok)      => ({ kind: 'Call', callee, args, tok }),
  Index:        (base, index, tok)       => ({ kind: 'Index', base, index, tok }),
  Member:       (obj, field, tok)        => ({ kind: 'Member', obj, field, tok }),
  Ident:        (name, tok)              => ({ kind: 'Ident', name, tok }),
  IntLit:       (value, tok)             => ({ kind: 'IntLit', value, tok }),
  FloatLit:     (value, tok)             => ({ kind: 'FloatLit', value, tok }),
  StringLit:    (value, tok)             => ({ kind: 'StringLit', value, tok }),
  BoolLit:      (value, tok)             => ({ kind: 'BoolLit', value, tok }),
  NullLit:      (tok)                    => ({ kind: 'NullLit', tok }),
  NewExpr:      (type, args, tok)        => ({ kind: 'NewExpr', type, args, tok }),
  CastExpr:     (type, expr, tok)        => ({ kind: 'CastExpr', type, expr, tok }),
  SenseExpr:    (index, tok)             => ({ kind: 'SenseExpr', index, tok }),
  FnRef:        (name, tok)              => ({ kind: 'FnRef', name, tok }),
  SelfRef:      (comp, attr, tok)        => ({ kind: 'SelfRef', comp, attr, tok }),
};

class Parser {
  constructor(tokens, filename = '<stdin>', source = '') {
    this.tokens = tokens;
    this.file = filename;
    this.source = source;  // raw source for asm slicing
    this.pos = 0;
  }

  error(msg, tok) {
    tok = tok || this.peek();
    throw new ParseError(msg, tok, this.file);
  }

  peek(offset = 0) { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  advance() { const t = this.tokens[this.pos]; if (t.type !== TT.EOF) this.pos++; return t; }

  check(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }

  eat(type, value) {
    if (!this.check(type, value)) {
      const got = this.peek();
      const exp = value !== undefined ? `'${value}'` : type;
      this.error(`Expected ${exp}`, got);
    }
    return this.advance();
  }

  match(...specs) {
    for (const [type, value] of specs) {
      if (this.check(type, value)) { return this.advance(); }
    }
    return null;
  }

  // ─── Type parsing ──────────────────────────────────────────────────────

  parseType() {
    const t = this.peek();
    if (t.type === TT.KEYWORD && ['int','float','bool','string','void','fn'].includes(t.value)) {
      this.advance();
      let base = t.value;
      if (this.check(TT.LBRACKET)) {
        this.advance();
        this.eat(TT.RBRACKET);
        return { base, isArray: true };
      }
      return { base, isArray: false };
    }
    if (t.type === TT.IDENT) {
      this.advance();
      let base = t.value;
      if (this.check(TT.LBRACKET)) {
        this.advance();
        this.eat(TT.RBRACKET);
        return { base, isArray: true };
      }
      return { base, isArray: false };
    }
    this.error(`Expected type`);
  }

  // ─── Top-level ─────────────────────────────────────────────────────────

  parse() {
    const decls = [];
    while (!this.check(TT.EOF)) {
      decls.push(this.parseTopLevel());
    }
    return N.Program(decls);
  }

  parseTopLevel() {
    const t = this.peek();

    // Decorators / modifiers
    let isInline = false, isStatic = false;
    while (this.check(TT.AT)) {
      this.advance();
      const mod = this.eat(TT.IDENT);
      if (mod.value === 'inline') isInline = true;
      else if (mod.value === 'static') isStatic = true;
    }

    if (this.check(TT.KEYWORD, 'import')) return this.parseImport();
    if (this.check(TT.KEYWORD, 'struct')) return this.parseStructDecl();
    if (this.check(TT.KEYWORD, 'fn')) return this.parseFnDecl(isInline, isStatic);
    if (this.check(TT.KEYWORD, 'static'))   return this.parseVarDecl();
    if (this.check(TT.KEYWORD, 'let') || this.check(TT.KEYWORD, 'const')) return this.parseVarDecl();
    this.error(`Expected top-level declaration`, t);
  }

  parseImport() {
    const tok = this.eat(TT.KEYWORD, 'import');
    const path = this.eat(TT.STRING);
    this.eat(TT.SEMICOLON);
    return N.Import(path.value, tok);
  }

  parseStructDecl() {
    const tok = this.eat(TT.KEYWORD, 'struct');
    const name = this.eat(TT.IDENT).value;
    this.eat(TT.LBRACE);
    const fields = [];
    while (!this.check(TT.RBRACE) && !this.check(TT.EOF)) {
      const ftok = this.peek();
      const fname = this.eat(TT.IDENT).value;
      this.eat(TT.COLON);
      const ftype = this.parseType();
      this.eat(TT.SEMICOLON);
      fields.push(N.FieldDecl(fname, ftype, ftok));
    }
    this.eat(TT.RBRACE);
    return N.StructDecl(name, fields, tok);
  }

  parseFnDecl(isInline = false, isStatic = false) {
    const tok = this.eat(TT.KEYWORD, 'fn');
    const name = this.eat(TT.IDENT).value;
    this.eat(TT.LPAREN);
    const params = [];
    while (!this.check(TT.RPAREN) && !this.check(TT.EOF)) {
      const ptok = this.peek();
      const pname = this.eat(TT.IDENT).value;
      this.eat(TT.COLON);
      const ptype = this.parseType();
      params.push(N.Param(pname, ptype, ptok));
      if (!this.check(TT.RPAREN)) this.eat(TT.COMMA);
    }
    this.eat(TT.RPAREN);
    let retType = { base: 'void', isArray: false };
    if (this.check(TT.COLON)) {
      this.advance();
      retType = this.parseType();
    }
    const body = this.parseBlock();
    return N.FnDecl(name, params, retType, body, isInline, isStatic, tok);
  }

  parseBlock() {
    const tok = this.eat(TT.LBRACE);
    const stmts = [];
    while (!this.check(TT.RBRACE) && !this.check(TT.EOF)) {
      stmts.push(this.parseStmt());
    }
    this.eat(TT.RBRACE);
    return N.Block(stmts, tok);
  }

  parseStmt() {
    const t = this.peek();

    if (this.check(TT.KEYWORD, 'static'))   return this.parseVarDecl();
    if (this.check(TT.KEYWORD, 'let') || this.check(TT.KEYWORD, 'const')) return this.parseVarDecl();
    if (this.check(TT.KEYWORD, 'if'))       return this.parseIfStmt();
    if (this.check(TT.KEYWORD, 'while'))    return this.parseWhileStmt();
    if (this.check(TT.KEYWORD, 'for'))      return this.parseForStmt();
    if (this.check(TT.KEYWORD, 'return'))   return this.parseReturnStmt();
    if (this.check(TT.KEYWORD, 'break'))    { this.advance(); this.eat(TT.SEMICOLON); return N.BreakStmt(t); }
    if (this.check(TT.KEYWORD, 'continue')) { this.advance(); this.eat(TT.SEMICOLON); return N.ContinueStmt(t); }
    if (this.check(TT.KEYWORD, 'asm'))      return this.parseAsmStmt();
    if (this.check(TT.KEYWORD, 'broadcast'))return this.parseBroadcastStmt();
    if (this.check(TT.KEYWORD, 'wait'))     return this.parseWaitStmt();
    if (this.check(TT.LBRACE))             return this.parseBlock();

    return this.parseExprStmt();
  }

  parseVarDecl() {
    const tok = this.peek();
    // optional leading 'static'
    let isStatic = false;
    if (this.check(TT.KEYWORD, 'static')) { this.advance(); isStatic = true; }
    const kw = this.advance(); // 'let' or 'const'
    const isConst = kw.value === 'const';
    const name = this.eat(TT.IDENT).value;
    let type = null;
    if (this.check(TT.COLON)) { this.advance(); type = this.parseType(); }
    let init = null;
    if (this.check(TT.EQ)) { this.advance(); init = this.parseExpr(); }
    this.eat(TT.SEMICOLON);
    return N.VarDecl(name, type, init, isConst, isStatic, tok);
  }

  parseIfStmt() {
    const tok = this.eat(TT.KEYWORD, 'if');
    this.eat(TT.LPAREN);
    const cond = this.parseExpr();
    this.eat(TT.RPAREN);
    const then = this.parseBlock();
    let els = null;
    if (this.check(TT.KEYWORD, 'else')) {
      this.advance();
      els = this.check(TT.KEYWORD, 'if') ? this.parseIfStmt() : this.parseBlock();
    }
    return N.IfStmt(cond, then, els, tok);
  }

  parseWhileStmt() {
    const tok = this.eat(TT.KEYWORD, 'while');
    this.eat(TT.LPAREN);
    const cond = this.parseExpr();
    this.eat(TT.RPAREN);
    const body = this.parseBlock();
    return N.WhileStmt(cond, body, tok);
  }

  parseForStmt() {
    const tok = this.eat(TT.KEYWORD, 'for');
    this.eat(TT.LPAREN);
    let init = null;
    if (!this.check(TT.SEMICOLON)) {
      if (this.check(TT.KEYWORD, 'let') || this.check(TT.KEYWORD, 'const')) init = this.parseVarDecl();
      else { init = N.ExprStmt(this.parseExpr(), this.peek()); this.eat(TT.SEMICOLON); }
    } else this.eat(TT.SEMICOLON);
    let cond = null;
    if (!this.check(TT.SEMICOLON)) cond = this.parseExpr();
    this.eat(TT.SEMICOLON);
    let post = null;
    if (!this.check(TT.RPAREN)) post = this.parseExpr();
    this.eat(TT.RPAREN);
    const body = this.parseBlock();
    return N.ForStmt(init, cond, post, body, tok);
  }

  parseReturnStmt() {
    const tok = this.eat(TT.KEYWORD, 'return');
    let value = null;
    if (!this.check(TT.SEMICOLON)) value = this.parseExpr();
    this.eat(TT.SEMICOLON);
    return N.ReturnStmt(value, tok);
  }

  parseAsmStmt() {
    const tok = this.eat(TT.KEYWORD, 'asm');
    const openBrace = this.eat(TT.LBRACE);
    // Slice raw source between the braces using token startPos offsets
    const start = openBrace.startPos + 1; // character after '{'
    // Walk tokens to find the matching closing brace
    let depth = 1;
    while (!this.check(TT.EOF)) {
      if (this.check(TT.LBRACE)) depth++;
      if (this.check(TT.RBRACE)) { depth--; if (depth === 0) break; }
      this.advance();
    }
    const closeTok = this.peek();
    const end = closeTok.startPos; // character before '}'
    const rawCode = this.source.slice(start, end).trim();
    this.eat(TT.RBRACE);
    return N.AsmStmt(rawCode, tok);
  }

  parseBroadcastStmt() {
    const tok = this.eat(TT.KEYWORD, 'broadcast');
    const msg = this.eat(TT.STRING).value;
    this.eat(TT.SEMICOLON);
    return N.BroadcastStmt(msg, tok);
  }

  parseWaitStmt() {
    const tok = this.eat(TT.KEYWORD, 'wait');
    this.eat(TT.LPAREN);
    const expr = this.parseExpr();
    this.eat(TT.RPAREN);
    this.eat(TT.SEMICOLON);
    return N.WaitStmt(expr, tok);
  }

  parseExprStmt() {
    const tok = this.peek();
    const expr = this.parseExpr();
    this.eat(TT.SEMICOLON);
    return N.ExprStmt(expr, tok);
  }

  // ─── Expressions (Pratt-style precedence) ─────────────────────────────

  parseExpr() { return this.parseAssign(); }

  parseAssign() {
    const left = this.parseOr();
    const t = this.peek();
    const assignOps = [TT.EQ, TT.PLUSEQ, TT.MINUSEQ, TT.STAREQ, TT.SLASHEQ];
    if (assignOps.includes(t.type)) {
      this.advance();
      const value = this.parseAssign();
      return N.Assign(left, t.value, value, t);
    }
    return left;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.check(TT.PIPEPIPE)) {
      const op = this.advance();
      left = N.BinOp('||', left, this.parseAnd(), op);
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.check(TT.AMPAMP)) {
      const op = this.advance();
      left = N.BinOp('&&', left, this.parseEquality(), op);
    }
    return left;
  }

  parseEquality() {
    let left = this.parseRelational();
    while (this.check(TT.EQEQ) || this.check(TT.NEQ)) {
      const op = this.advance();
      left = N.BinOp(op.value, left, this.parseRelational(), op);
    }
    return left;
  }

  parseRelational() {
    let left = this.parseAddSub();
    while ([TT.LT, TT.GT, TT.LTE, TT.GTE].includes(this.peek().type)) {
      const op = this.advance();
      left = N.BinOp(op.value, left, this.parseAddSub(), op);
    }
    return left;
  }

  parseAddSub() {
    let left = this.parseMulDiv();
    while (this.check(TT.PLUS) || this.check(TT.MINUS)) {
      const op = this.advance();
      left = N.BinOp(op.value, left, this.parseMulDiv(), op);
    }
    return left;
  }

  parseMulDiv() {
    let left = this.parseUnary();
    while ([TT.STAR, TT.SLASH, TT.PERCENT].includes(this.peek().type)) {
      const op = this.advance();
      left = N.BinOp(op.value, left, this.parseUnary(), op);
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (this.check(TT.BANG)) { this.advance(); return N.UnOp('!', this.parseUnary(), t); }
    if (this.check(TT.MINUS)) { this.advance(); return N.UnOp('-', this.parseUnary(), t); }
    if (this.check(TT.PLUSPLUS)) { this.advance(); return N.UnOp('++pre', this.parsePostfix(), t); }
    if (this.check(TT.MINUSMINUS)) { this.advance(); return N.UnOp('--pre', this.parsePostfix(), t); }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (this.check(TT.DOT)) {
        this.advance();
        const field = this.eat(TT.IDENT).value;
        expr = N.Member(expr, field, t);
      } else if (this.check(TT.LBRACKET)) {
        this.advance();
        const idx = this.parseExpr();
        this.eat(TT.RBRACKET);
        expr = N.Index(expr, idx, t);
      } else if (this.check(TT.LPAREN)) {
        this.advance();
        const args = [];
        while (!this.check(TT.RPAREN) && !this.check(TT.EOF)) {
          args.push(this.parseExpr());
          if (!this.check(TT.RPAREN)) this.eat(TT.COMMA);
        }
        this.eat(TT.RPAREN);
        expr = N.Call(expr, args, t);
      } else if (this.check(TT.PLUSPLUS)) {
        this.advance();
        expr = N.PostOp('++', expr, t);
      } else if (this.check(TT.MINUSMINUS)) {
        this.advance();
        expr = N.PostOp('--', expr, t);
      } else break;
    }
    return expr;
  }

  parsePrimary() {
    const t = this.peek();

    // Literals
    if (t.type === TT.INT)    { this.advance(); return N.IntLit(t.value, t); }
    if (t.type === TT.FLOAT)  { this.advance(); return N.FloatLit(t.value, t); }
    if (t.type === TT.STRING) { this.advance(); return N.StringLit(t.value, t); }
    if (t.type === TT.BOOL)   { this.advance(); return N.BoolLit(t.value, t); }
    if (t.type === TT.KEYWORD && t.value === 'null') { this.advance(); return N.NullLit(t); }

    // new expression
    if (t.type === TT.KEYWORD && t.value === 'new') {
      this.advance();
      const type = this.parseType();
      let args = [];
      if (this.check(TT.LPAREN)) {
        this.advance();
        while (!this.check(TT.RPAREN)) { args.push(this.parseExpr()); if (!this.check(TT.RPAREN)) this.eat(TT.COMMA); }
        this.eat(TT.RPAREN);
      }
      return N.NewExpr(type, args, t);
    }

    // sensing.category.name  e.g. sensing.mouse.x, sensing.key.space
    if (t.type === TT.IDENT && t.value === 'sensing') {
      // peek ahead: must be sensing.cat.name (two dots)
      if (this.peek(1).type === TT.DOT) {
        this.advance(); // consume 'sensing'
        this.eat(TT.DOT);
        const cat = this.eat(TT.IDENT).value;
        this.eat(TT.DOT);
        const name = this.eat(TT.IDENT).value;
        return N.SenseExpr([cat, name], t);
      }
      // otherwise fall through to normal ident handling
    }

    // cast<type>(expr)
    if (t.type === TT.IDENT && t.value === 'cast') {
      this.advance();
      this.eat(TT.LT);
      const type = this.parseType();
      this.eat(TT.GT);
      this.eat(TT.LPAREN);
      const expr = this.parseExpr();
      this.eat(TT.RPAREN);
      return N.CastExpr(type, expr, t);
    }

    // entity@Component.attr  or  @Component.attr (self)
    if (t.type === TT.IDENT && this.peek(1).type === TT.AT) {
      const entityName = t.value;
      this.advance(); this.advance(); // ident + @
      const comp = this.eat(TT.IDENT).value;
      this.eat(TT.DOT);
      const attr = this.eat(TT.INT).value;
      return N.EntityRef(entityName, comp, attr, t);
    }
    if (t.type === TT.AT) {
      this.advance();
      const comp = this.eat(TT.IDENT).value;
      this.eat(TT.DOT);
      const attr = this.eat(TT.INT).value;
      return N.SelfRef(comp, attr, t);
    }

    // Parenthesized expression
    if (t.type === TT.LPAREN) {
      this.advance();
      const expr = this.parseExpr();
      this.eat(TT.RPAREN);
      return expr;
    }

    // Identifier
    if (t.type === TT.IDENT) { this.advance(); return N.Ident(t.value, t); }

    // self keyword
    if (t.type === TT.KEYWORD && t.value === 'self') { this.advance(); return N.Ident('self', t); }

    this.error(`Unexpected token in expression`, t);
  }
}

// Reconstruct raw source text from a token (used for asm blocks)
function tokenToRaw(t) {
  switch (t.type) {
    case TT.STRING: return `"${t.value}"`;
    default: return String(t.value);
  }
}

module.exports = { Parser, N };
