'use strict';
/**
 * S# Code Generator
 */

const { resolveSensing } = require('./sensing');

class CodeGenError extends Error {
  constructor(msg, tok) {
    const loc = tok ? `${tok.line}:${tok.col}: ` : '';
    super(`${loc}CodeGen error: ${msg}`);
  }
}

// Pad instruction opcode to 2 digits
const op = (n) => String(n).padStart(2, '0');

// ─── Opcode name → number table ──────────────────────────────────────────
const OPCODE_NAMES = {
  LDA:4,  // wait, LDA=00 below — handled as index 0
  // Map names to their numeric codes
};
const OPCODE_TABLE = {
  'LDA':0,'STA':1,'PUSH':2,'POP':3,'MSG':4,'ALO':5,'DLO':6,
  'DBL':7,'HLF':8,'INC':9,'DEC':10,'WAIT':11,'AND':12,'ORA':13,
  'NOT':14,'CGR':15,'CLS':16,'CEQ':17,'ADD':18,'SUB':19,'MUL':20,
  'DIV':21,'RAND':22,'RANF':23,'MOD':24,'ROUN':25,'FLR':26,'CEI':27,
  'ABS':28,'SIN':29,'COS':30,'TAN':31,'ASN':32,'ACS':33,'ATN':34,
  'SQT':35,'LNA':36,'LOG':37,'EEX':38,'TNE':39,'JOIN':40,'LTR':41,
  'LNG':42,'SCT':43,'JMP':44,'JSR':45,'RTS':46,'JIT':47,'JIF':48,
  'JST':49,'JSF':50,'LDX':51,'STX':52,'RST':57,
};

/**
 * Preprocess an asm block's raw text:
 * - Replace opcode names with their 2-digit numbers
 * - Strip whitespace/newlines between instructions
 * - Leave string contents and addressing suffixes intact
 *
 * Input example:  RST;  LDA I42;  STA Z3;
 * Output example: 57;00I42;01Z3;
 */
function preprocessAsm(raw) {
  // Split on semicolons to get individual instruction tokens,
  // but respect quoted strings (semicolons inside quotes are not separators).
  const instructions = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && raw[i-1] !== '\\') { inString = !inString; current += ch; }
    else if (ch === ';' && !inString) {
      const trimmed = current.trim();
      if (trimmed) instructions.push(trimmed + ';');
      current = '';
    } else if (!inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      current += ' '; // collapse whitespace
    } else {
      current += ch;
    }
  }
  const leftover = current.trim();
  if (leftover) instructions.push(leftover + ';');

  // For each instruction, replace the leading opcode name with its number.
  return instructions.map(instr => {
    // An instruction is:  NAME[addressing][content];
    // NAME is all uppercase letters (2-4 chars), possibly followed immediately
    // by an addressing character or whitespace.
    const match = instr.match(/^([A-Z]{2,4})(.*)/s);
    if (!match) return instr; // pass through as-is (already numeric, or comment)
    const [, name, rest] = match;
    const code = OPCODE_TABLE[name];
    if (code === undefined) {
      throw new CodeGenError(`Unknown opcode name '${name}' in asm block`);
    }
    // Remove any whitespace between the opcode name and its operand
    return `${op(code)}${rest.trimStart()}`;
  }).join('');
}

class CodeGenerator {
  constructor(symbolTable) {
    this.sym = symbolTable;
    this.lines = [];         // Output lines
    this.labelCounter = 0;
    this.currentFnName = null;
    this.loopStack = [];     // { continueLabel, breakLabel }
    this.fnLabels = {};      // fn name -> label
    this.returnLabel = null; // label for current function's exit
    this.fnReturnSlot = null;// ZP slot for return value temp
  }

  // ─── Label utilities ────────────────────────────────────────────────────

  newLabel(hint = 'L') { return `${hint}_${++this.labelCounter}`; }

  emitLabel(label) { this.lines.push(`:${label}`); }

  /**
   * Two-phase character-offset label resolver.
   *
   * The jump opcodes store a CHARACTER OFFSET into the bytecode string, not
   * an instruction index.  Because instruction lengths vary (e.g. a long
   * string immediate is much wider than a bare RTS), we cannot know the
   * offset of instruction N until we know the rendered text of every
   * instruction before it — which itself depends on the numeric value of any
   * embedded label reference (because "44I8;" and "44I1024;" differ in length).
   *
   * Strategy: iterative fixed-point.
   *   1. Strip label pseudo-lines; build ordered instruction list.
   *   2. Render each instruction, substituting label refs with the CURRENT
   *      best-guess character offset (initially 0 for all labels).
   *   3. Walk the rendered instructions to compute each instruction's start
   *      character position.  Update labelMap with these positions.
   *   4. If any label's position changed, re-render and repeat.
   *      In practice this converges in 2-3 iterations because the only
   *      feedback is digit-count changes (e.g. 9→10, 99→100).
   */
  resolveLabels() {
    // ── Phase 1: separate labels from instructions ──
    // labelOrder[i] = set of label names that sit BEFORE instruction i
    const instrs = [];          // raw instruction strings (with @LABEL placeholders)
    const labelsBefore = [];    // labelsBefore[i] = [labelName, ...]
    let pendingLabels = [];

    for (const line of this.lines) {
      if (line.startsWith(':')) {
        pendingLabels.push(line.slice(1));
      } else {
        labelsBefore.push(pendingLabels);
        pendingLabels = [];
        instrs.push(line);
      }
    }
    // Any trailing labels after last instruction point past the end
    const trailingLabels = pendingLabels;

    // ── Phase 2: iterative character-offset resolution ──
    // labelCharPos[name] = character offset of that label's position
    const labelCharPos = {};

    // Initialize all labels to 0
    const allLabels = new Set();
    for (const group of labelsBefore) for (const l of group) allLabels.add(l);
    for (const l of trailingLabels) allLabels.add(l);
    for (const l of allLabels) labelCharPos[l] = 0;

    const PLACEHOLDER_RE = /@([A-Za-z_][A-Za-z0-9_]*)/g;

    const renderInstr = (instr) =>
      instr.replace(PLACEHOLDER_RE, (_, lbl) => {
        if (labelCharPos[lbl] === undefined)
          throw new CodeGenError(`Undefined label '${lbl}'`);
        return labelCharPos[lbl];
      });

    let changed = true;
    let rendered = [];
    const MAX_ITER = 20;
    let iter = 0;

    while (changed && iter++ < MAX_ITER) {
      changed = false;

      // Render all instructions with current label positions
      rendered = instrs.map(renderInstr);

      // Walk rendered instructions to compute character positions
      let charPos = 0;
      for (let i = 0; i < rendered.length; i++) {
        // Update any labels that point HERE (before this instruction)
        for (const lbl of labelsBefore[i]) {
          if (labelCharPos[lbl] !== charPos) {
            labelCharPos[lbl] = charPos;
            changed = true;
          }
        }
        charPos += rendered[i].length;
      }
      // Trailing labels point to the end of the bytecode
      for (const lbl of trailingLabels) {
        if (labelCharPos[lbl] !== charPos) {
          labelCharPos[lbl] = charPos;
          changed = true;
        }
      }
    }

    return rendered;
  }

  // ─── Instruction emitters ────────────────────────────────────────────

  // Raw instruction
  emit(instr) { this.lines.push(instr); }

  // S# Runtime lists are 1-indexed (Scratch lists), so add 1 to every internal 0-based slot.
  zp(slot) { return slot + 1; }

  // LDA: Load immediate into A
  LDA_imm(val) {
    if (typeof val === 'string') this.emit(`${op(0)}I"${val}";`);
    else this.emit(`${op(0)}I${val};`);
  }

  LDA_zp(slot)   { this.emit(`${op(0)}Z${this.zp(slot)};`); }
  STA_zp(slot)   { this.emit(`${op(1)}Z${this.zp(slot)};`); }
  LDA_zpx(slot)  { this.emit(`${op(0)}Y${this.zp(slot)};`); }
  STA_zpx(slot)  { this.emit(`${op(1)}Y${this.zp(slot)};`); }

  PUSH_A()       { this.emit(`${op(2)};`); }
  POP_A()        { this.emit(`${op(3)};`); }
  PUSH_imm(val)  { this.LDA_imm(val); this.PUSH_A(); }
  POP_zp(slot)   { this.emit(`${op(3)}Z${this.zp(slot)};`); }

  // Arithmetic
  ADD_imm(val)   { this.emit(`${op(18)}I${val};`); }
  ADD_zp(slot)   { this.emit(`${op(18)}Z${slot};`); }
  SUB_imm(val)   { this.emit(`${op(19)}I${val};`); }
  SUB_zp(slot)   { this.emit(`${op(19)}Z${slot};`); }
  MUL_imm(val)   { this.emit(`${op(20)}I${val};`); }
  MUL_zp(slot)   { this.emit(`${op(20)}Z${slot};`); }
  DIV_imm(val)   { this.emit(`${op(21)}I${val};`); }
  DIV_zp(slot)   { this.emit(`${op(21)}Z${slot};`); }
  MOD_zp(slot)   { this.emit(`${op(24)}Z${slot};`); }
  MOD_imm(val)   { this.emit(`${op(24)}I${val};`); }

  INC_A()        { this.emit(`${op(9)};`); }
  DEC_A()        { this.emit(`${op(10)};`); }
  DBL_A()        { this.emit(`${op(7)};`); }
  HLF_A()        { this.emit(`${op(8)};`); }

  // Boolean / comparison
  AND_zp(slot)   { this.emit(`${op(12)}Z${slot};`); }
  ORA_zp(slot)   { this.emit(`${op(13)}Z${slot};`); }
  NOT_A()        { this.emit(`${op(14)};`); }
  CGR_imm(val)   { this.emit(`${op(15)}I${val};`); }
  CGR_zp(slot)   { this.emit(`${op(15)}Z${slot};`); }
  CLS_imm(val)   { this.emit(`${op(16)}I${val};`); }
  CLS_zp(slot)   { this.emit(`${op(16)}Z${slot};`); }
  CEQ_imm(val)   { this.emit(`${op(17)}I${val};`); }
  CEQ_zp(slot)   { this.emit(`${op(17)}Z${slot};`); }

  // Math intrinsics
  ABS_A()        { this.emit(`${op(28)};`); }
  SIN_A()        { this.emit(`${op(29)};`); }
  COS_A()        { this.emit(`${op(30)};`); }
  TAN_A()        { this.emit(`${op(31)};`); }
  ASN_A()        { this.emit(`${op(32)};`); }
  ACS_A()        { this.emit(`${op(33)};`); }
  ATN_A()        { this.emit(`${op(34)};`); }
  SQT_A()        { this.emit(`${op(35)};`); }
  LNA_A()        { this.emit(`${op(36)};`); }
  LOG_A()        { this.emit(`${op(37)};`); }
  EEX_A()        { this.emit(`${op(38)};`); }
  TNE_A()        { this.emit(`${op(39)};`); }
  ROUN_A()       { this.emit(`${op(25)};`); }
  FLR_A()        { this.emit(`${op(26)};`); }
  CEI_A()        { this.emit(`${op(27)};`); }

  // String
  JOIN_imm(s)    { this.emit(`${op(40)}I"${s}";`); }
  JOIN_zp(slot)  { this.emit(`${op(40)}Z${slot};`); }
  LNG_A()        { this.emit(`${op(42)};`); }
  SCT_imm(s)     { this.emit(`${op(43)}I"${s}";`); }

  // Control flow
  JMP(label)     { this.emit(`${op(44)}I@${label};`); }
  JSR(label)     { this.emit(`${op(45)}I@${label};`); }
  RTS()          { this.emit(`${op(46)};`); }
  JIT(label)     { this.emit(`${op(47)}I@${label};`); }
  JIF(label)     { this.emit(`${op(48)}I@${label};`); }
  JST(label)     { this.emit(`${op(49)}I@${label};`); }
  JSF(label)     { this.emit(`${op(50)}I@${label};`); }

  // Memory
  ALO_imm(n)     { this.emit(`${op(5)}I${n};`); }
  DLO_A()        { this.emit(`${op(6)};`); }
  MSG(s)         { this.emit(`${op(4)}I"${s}";`); }
  WAIT_A()       { this.emit(`${op(11)};`); }
  WAIT_imm(v)    { this.emit(`${op(11)}I${v};`); }
  SENSE(idx)     { this.emit(`${op(0)}S${idx};`); }

  // Entity/component access
  ENT_read(entity, comp, attr)  { this.emit(`${op(0)}C${entity}.${comp}.${attr};`); }
  ENT_write(entity, comp, attr) { this.emit(`${op(1)}C${entity}.${comp}.${attr};`); }
  SELF_read(comp, attr)         { this.emit(`${op(0)}D${comp}.${attr};`); }
  SELF_write(comp, attr)        { this.emit(`${op(1)}D${comp}.${attr};`); }

  // X register
  LDX_imm(val)   { this.emit(`${op(51)}I${val};`); }
  STX_zp(slot)   { this.emit(`${op(52)}Z${this.zp(slot)};`); }

  // Indirect JSR — calls the address stored at the given location
  // N addressing: the operand is itself an address whose contents are the target
  JSR_ind_zp(slot)              { this.emit(`${op(45)}NZ${this.zp(slot)};`); }
  JSR_ind_ent(entity, comp, attr){ this.emit(`${op(45)}NC${entity}.${comp}.${attr};`); }
  JSR_ind_self(comp, attr)       { this.emit(`${op(45)}ND${comp}.${attr};`); }

  // ─── Code generation entry point ─────────────────────────────────────

  generate(ast) {
    const statics = this.sym.statics;
    const hasStatics = statics.length > 0;
    const hasUserInit = !!this.sym.functions['init'];

    // Snapshot user statics BEFORE injecting the hidden flag, so the init
    // block only writes user-declared values (not the flag itself).
    const userStatics = [...statics];

    // The hidden __initialized flag is injected as the last static so it
    // doesn't shift any user static slot numbers.
    let initFlagSlot = null;
    if (hasStatics || hasUserInit) {
      initFlagSlot = this.sym.allocZP('__initialized');
      this.sym.statics.push({ name: '__initialized', initValue: 0, slot: initFlagSlot });
    }

    // Emit a jump over all function bodies to the entry point
    const entryLabel = this.newLabel('entry');
    this.JMP(entryLabel);

    // Generate all user functions
    for (const decl of ast.decls) {
      if (decl.kind === 'FnDecl') this.genFn(decl);
    }

    // ── Entry point ──
    this.emitLabel(entryLabel);

    // Initialize non-static globals
    for (const decl of ast.decls) {
      if (decl.kind === 'VarDecl' && decl.init && !decl.isStatic) {
        this.genExpr(decl.init);
        this.STA_zp(this.sym.getZP(decl.name));
      }
    }

    // ── First-run init block ──
    // if (__initialized == 0) { <init statics>; fn init() if present; __initialized = 1; }
    if (initFlagSlot !== null) {
      const skipInitLabel = this.newLabel('skip_init');
      this.LDA_zp(initFlagSlot);
      this.JIT(skipInitLabel);   // skip if already initialized

      // Write each user static's initial value into its zp slot
      for (const s of userStatics) {
        this.LDA_imm(s.initValue);
        this.STA_zp(s.slot);
      }

      // Call user's init() if they defined one
      if (hasUserInit) {
        this.JSR('fn_init');
      }

      // Mark as initialized
      this.LDA_imm(1);
      this.STA_zp(initFlagSlot);

      this.emitLabel(skipInitLabel);
    }

    // Call main
    if (this.sym.functions['main']) {
      this.JSR('fn_main');
    }

    const resolved = this.resolveLabels();
    const bytecode = resolved.join('');  // single continuous string, no newlines

    // ── Output file: 2 lines ──
    // Line 1: total number of static variables (including hidden __initialized flag)
    // Line 2: bytecode string
    return `${this.sym.statics.length}\n${bytecode}`;
  }

  // ─── Function code gen ───────────────────────────────────────────────

  genFn(decl) {
    const fnLabel = `fn_${decl.name}`;
    this.fnLabels[decl.name] = fnLabel;
    this.emitLabel(fnLabel);

    this.currentFnName = decl.name;
    this.returnLabel = this.newLabel(`ret_${decl.name}`);

    // Callee: pop args from stack in REVERSE order (last arg first)
    const params = [...decl.params].reverse();
    for (const param of params) {
      this.POP_zp(param._slot);
    }

    this.genBlock(decl.body);

    this.emitLabel(this.returnLabel);
    this.RTS();
    this.currentFnName = null;
    this.returnLabel = null;
  }

  genBlock(block) {
    for (const stmt of block.stmts) this.genStmt(stmt);
  }

  // ─── Statement code gen ──────────────────────────────────────────────

  genStmt(stmt) {
    switch (stmt.kind) {
      case 'VarDecl': {
        if (stmt.init) {
          this.genExpr(stmt.init);
          this.STA_zp(stmt._slot);
        } else {
          // Default init to 0
          this.LDA_imm(0);
          this.STA_zp(stmt._slot);
        }
        break;
      }

      case 'ExprStmt':
        this.genExpr(stmt.expr);
        break;

      case 'IfStmt': {
        const elseLabel = this.newLabel('else');
        const endLabel  = this.newLabel('endif');
        this.genExpr(stmt.cond);
        this.JIF(elseLabel);
        this.genBlock(stmt.then);
        if (stmt.els) {
          this.JMP(endLabel);
          this.emitLabel(elseLabel);
          if (stmt.els.kind === 'IfStmt') this.genStmt(stmt.els);
          else this.genBlock(stmt.els);
          this.emitLabel(endLabel);
        } else {
          this.emitLabel(elseLabel);
        }
        break;
      }

      case 'WhileStmt': {
        const topLabel  = this.newLabel('while');
        const endLabel  = this.newLabel('endwhile');
        this.loopStack.push({ continueLabel: topLabel, breakLabel: endLabel });
        this.emitLabel(topLabel);
        this.genExpr(stmt.cond);
        this.JIF(endLabel);
        this.genBlock(stmt.body);
        this.JMP(topLabel);
        this.emitLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'ForStmt': {
        const topLabel  = this.newLabel('for');
        const contLabel = this.newLabel('forcont');
        const endLabel  = this.newLabel('endfor');
        if (stmt.init) this.genStmt(stmt.init);
        this.loopStack.push({ continueLabel: contLabel, breakLabel: endLabel });
        this.emitLabel(topLabel);
        if (stmt.cond) {
          this.genExpr(stmt.cond);
          this.JIF(endLabel);
        }
        this.genBlock(stmt.body);
        this.emitLabel(contLabel);
        if (stmt.post) this.genExpr(stmt.post);
        this.JMP(topLabel);
        this.emitLabel(endLabel);
        this.loopStack.pop();
        break;
      }

      case 'ReturnStmt': {
        if (stmt.value) {
          this.genExpr(stmt.value);
          // A holds return value; caller will pop it
        }
        this.JMP(this.returnLabel);
        break;
      }

      case 'BreakStmt': {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.JMP(loop.breakLabel);
        break;
      }

      case 'ContinueStmt': {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.JMP(loop.continueLabel);
        break;
      }

      case 'Block':
        this.genBlock(stmt);
        break;

      case 'AsmStmt':
        // Inline assembly: resolve opcode names to numbers, strip whitespace
        this.emit(preprocessAsm(stmt.code));
        break;

      case 'BroadcastStmt':
        this.MSG(stmt.msg);
        break;

      case 'WaitStmt':
        this.genExpr(stmt.expr);
        this.WAIT_A();
        break;

      case 'AllocStmt':
        this.genExpr(stmt.expr);
        this.emit(`${op(5)};`); // ALO with A
        break;

      case 'FreeStmt':
        this.genExpr(stmt.expr);
        this.DLO_A();
        break;

      case 'DeleteStmt':
        // Stub: in a real allocator, would reclaim zp slots
        break;

      default:
        throw new CodeGenError(`Unknown statement kind '${stmt.kind}'`);
    }
  }

  // ─── Expression code gen ─────────────────────────────────────────────
  // Convention: result is always left in A after genExpr returns.

  genExpr(expr) {
    switch (expr.kind) {

      case 'IntLit':   this.LDA_imm(expr.value); break;
      case 'FloatLit': this.LDA_imm(expr.value); break;
      case 'BoolLit':  this.LDA_imm(expr.value ? 1 : 0); break;
      case 'StringLit':this.LDA_imm(expr.value); break;
      case 'NullLit':  this.LDA_imm(0); break;

      case 'Ident': {
        // If semantic pass tagged it as a fn ref used as a value
        if (expr._isFnRef) {
          this.emit(`${op(0)}I@fn_${expr._fnName};`);
        } else {
          const slot = expr._slot;
          if (slot !== undefined) this.LDA_zp(slot);
          else throw new CodeGenError(`Cannot load identifier '${expr.name}' as value`, expr.tok);
        }
        break;
      }

      case 'FnRef':
        // Bare function name used as a value — emit its label as an immediate offset
        this.emit(`${op(0)}I@fn_${expr.name};`);
        break;

      case 'EntityRef':
        this.ENT_read(expr.entity, expr.comp, expr.attr);
        break;

      case 'SelfRef':
        this.SELF_read(expr.comp, expr.attr);
        break;

      case 'SenseExpr': {
        const idx = resolveSensing(expr.index);
        if (idx === null)
          throw new CodeGenError(
            `Unknown sensing path 'sensing.${expr.index.join('.')}'`, expr.tok);
        this.SENSE(idx);
        break;
      }

      case 'UnOp':
        switch (expr.op) {
          case '!':
            this.genExpr(expr.operand);
            this.NOT_A();
            break;
          case '-':
            this.genExpr(expr.operand);
            // Negate: A = 0 - A
            this.PUSH_A();
            this.LDA_imm(0);
            this.SUB_zp(this._tempStore()); // use a temp trick
            // Simpler: push, load 0, SUB from stack
            // We implement negate as: push operand, load 0, sub via a temp zp
            this.POP_A(); // restore
            this.negateA(); // helper
            break;
          case '++pre': {
            const slot = this.getWriteSlot(expr.operand);
            this.LDA_zp(slot);
            this.INC_A();
            this.STA_zp(slot);
            break;
          }
          case '--pre': {
            const slot = this.getWriteSlot(expr.operand);
            this.LDA_zp(slot);
            this.DEC_A();
            this.STA_zp(slot);
            break;
          }
        }
        break;

      case 'PostOp': {
        const slot = this.getWriteSlot(expr.operand);
        this.LDA_zp(slot); // load old value (return value)
        if (expr.op === '++') {
          this.PUSH_A();
          this.INC_A();
          this.STA_zp(slot);
          this.POP_A();
        } else {
          this.PUSH_A();
          this.DEC_A();
          this.STA_zp(slot);
          this.POP_A();
        }
        break;
      }

      case 'BinOp':
        this.genBinOp(expr);
        break;

      case 'Assign':
        this.genAssign(expr);
        break;

      case 'Call':
        this.genCall(expr);
        break;

      case 'Member':
        // struct.field - for now generate as a zp reference
        // In a full implementation this would use a struct layout table
        this.genExpr(expr.obj);
        // Field access left as-is (would need struct offset table)
        break;

      case 'Index':
        // array[i] -> LDA Y(base + i) using X register
        this.genExpr(expr.index);
        // store to X implicitly via STX
        // For now: generate base address in A, load via Y addressing
        this.genIndexAccess(expr);
        break;

      case 'NewExpr':
        // Allocate N zero-page slots and return base slot index
        this.LDA_imm(expr.args.length || 1);
        this.emit(`${op(5)};`); // ALO
        break;

      case 'CastExpr':
        this.genExpr(expr.expr);
        // In the S# runtime, types are dynamic; cast is largely a no-op
        // ROUN handles int cast from float
        if (expr.type.base === 'int') this.ROUN_A();
        break;

      default:
        throw new CodeGenError(`Unknown expression kind '${expr.kind}'`, expr.tok);
    }
  }

  negateA() {
    // Negate value in A: push, load 0, SUB stack value
    // Use a known scratch zp slot 0 as temp (caller must not depend on zp0)
    this.PUSH_A();
    this.LDA_imm(0);
    // We need SUB with the popped value: push 0, pop to temp, load old, sub temp
    // Easier: store A to a temp slot, load 0, sub temp
    const tmpSlot = this._getTempSlot();
    this.POP_zp(tmpSlot);
    this.LDA_imm(0);
    this.SUB_zp(tmpSlot);
  }

  _tempSlot = null;
  _getTempSlot() {
    if (this._tempSlot === null) {
      this._tempSlot = this.sym.allocZP('__neg_tmp');
    }
    return this._tempSlot;
  }
  _tempStore() { return this._getTempSlot(); }

  genBinOp(expr) {
    const op2 = expr.op;

    // Short-circuit for && and ||
    if (op2 === '&&') {
      const falseLabel = this.newLabel('and_false');
      const endLabel   = this.newLabel('and_end');
      this.genExpr(expr.left);
      this.JIF(falseLabel);
      this.genExpr(expr.right);
      this.JMP(endLabel);
      this.emitLabel(falseLabel);
      this.LDA_imm(0);
      this.emitLabel(endLabel);
      return;
    }
    if (op2 === '||') {
      const trueLabel = this.newLabel('or_true');
      const endLabel  = this.newLabel('or_end');
      this.genExpr(expr.left);
      this.JIT(trueLabel);
      this.genExpr(expr.right);
      this.JMP(endLabel);
      this.emitLabel(trueLabel);
      this.LDA_imm(1);
      this.emitLabel(endLabel);
      return;
    }

    // For non-short-circuit binops:
    // Eval left -> push; eval right -> use as operand
    this.genExpr(expr.left);
    this.PUSH_A();

    if (expr.right.kind === 'IntLit' || expr.right.kind === 'FloatLit') {
      // Immediate RHS: pop left into A, then operate with immediate
      this.POP_A();
      const rval = expr.right.value;
      switch (op2) {
        case '+':  this.ADD_imm(rval); break;
        case '-':  this.SUB_imm(rval); break;
        case '*':  this.MUL_imm(rval); break;
        case '/':  this.DIV_imm(rval); break;
        case '%':  this.MOD_imm(rval); break;
        case '>':  this.CGR_imm(rval); break;
        case '<':  this.CLS_imm(rval); break;
        case '>=': {
          // A >= B  <=>  !(A < B)
          this.CLS_imm(rval); this.NOT_A(); break;
        }
        case '<=': {
          this.CGR_imm(rval); this.NOT_A(); break;
        }
        case '==': this.CEQ_imm(rval); break;
        case '!=': this.CEQ_imm(rval); this.NOT_A(); break;
        default: throw new CodeGenError(`Unknown binary operator '${op2}'`, expr.tok);
      }
    } else {
      // General RHS: eval right into a temp slot, then operate
      this.genExpr(expr.right);
      const tmpSlot = this.sym.allocZP('__binop_tmp' + this.labelCounter);
      this.STA_zp(tmpSlot);
      this.POP_A(); // left value now in A
      switch (op2) {
        case '+':  this.ADD_zp(tmpSlot); break;
        case '-':  this.SUB_zp(tmpSlot); break;
        case '*':  this.MUL_zp(tmpSlot); break;
        case '/':  this.DIV_zp(tmpSlot); break;
        case '%':  this.MOD_zp(tmpSlot); break;
        case '>':  this.CGR_zp(tmpSlot); break;
        case '<':  this.CLS_zp(tmpSlot); break;
        case '>=': this.CLS_zp(tmpSlot); this.NOT_A(); break;
        case '<=': this.CGR_zp(tmpSlot); this.NOT_A(); break;
        case '==': this.CEQ_zp(tmpSlot); break;
        case '!=': this.CEQ_zp(tmpSlot); this.NOT_A(); break;
        default: throw new CodeGenError(`Unknown binary operator '${op2}'`, expr.tok);
      }
    }
  }

  genAssign(expr) {
    this.genExpr(expr.value);

    if (expr.op !== '=') {
      // Compound assignment: load LHS, operate, store
      const slot = this.getWriteSlot(expr.target);
      const rval_slot = this.sym.allocZP('__cas_tmp' + this.labelCounter);
      this.STA_zp(rval_slot); // store rhs
      this.LDA_zp(slot);      // load lhs
      switch (expr.op) {
        case '+=': this.ADD_zp(rval_slot); break;
        case '-=': this.SUB_zp(rval_slot); break;
        case '*=': this.MUL_zp(rval_slot); break;
        case '/=': this.DIV_zp(rval_slot); break;
      }
      this.storeToTarget(expr.target);
    } else {
      this.storeToTarget(expr.target);
    }
  }

  storeToTarget(target) {
    switch (target.kind) {
      case 'Ident': {
        const slot = target._slot;
        if (slot === undefined) throw new CodeGenError(`Cannot assign to '${target.name}'`, target.tok);
        this.STA_zp(slot);
        break;
      }
      case 'EntityRef':
        this.ENT_write(target.entity, target.comp, target.attr);
        break;
      case 'SelfRef':
        this.SELF_write(target.comp, target.attr);
        break;
      case 'Index':
        this.genIndexWrite(target);
        break;
      case 'Member':
        // For now treat member as ZP
        this.genExpr(target.obj);
        break;
      default:
        throw new CodeGenError(`Cannot assign to ${target.kind}`, target.tok);
    }
  }

  getWriteSlot(expr) {
    if (expr.kind === 'Ident' && expr._slot !== undefined) return expr._slot;
    throw new CodeGenError(`Cannot get write slot for ${expr.kind}`, expr.tok);
  }

  genIndexAccess(expr) {
    // For array indexing: compute index -> load to X register, then use Y addressing
    // base must be a simple ident with a slot
    if (expr.base.kind === 'Ident') {
      const baseSlot = expr.base._slot;
      this.genExpr(expr.index);
      this.emit(`${op(51)};`); // LDX (load A into X)
      this.emit(`${op(0)}Y${baseSlot};`); // LDA Y{base}
    } else {
      // Fallback
      this.genExpr(expr.base);
    }
  }

  genIndexWrite(expr) {
    if (expr.base.kind === 'Ident') {
      const baseSlot = expr.base._slot;
      const valSlot = this.sym.allocZP('__idx_val' + this.labelCounter);
      this.STA_zp(valSlot); // save value
      this.genExpr(expr.index);
      this.emit(`${op(51)};`); // LDX
      this.LDA_zp(valSlot);
      this.emit(`${op(1)}Y${baseSlot};`); // STA Y{base}
    }
  }

  genCall(expr) {
    // Push args left to right regardless of call type
    const pushArgs = () => {
      for (const arg of expr.args) { this.genExpr(arg); this.PUSH_A(); }
    };

    // ── Built-in functions (direct ident only) ──
    if (expr.callee.kind === 'Ident' && !expr._indirect) {
      const name = expr.callee.name;
      const builtins = {
        'abs':    () => { this.genExpr(expr.args[0]); this.ABS_A(); },
        'sin':    () => { this.genExpr(expr.args[0]); this.SIN_A(); },
        'cos':    () => { this.genExpr(expr.args[0]); this.COS_A(); },
        'tan':    () => { this.genExpr(expr.args[0]); this.TAN_A(); },
        'asin':   () => { this.genExpr(expr.args[0]); this.ASN_A(); },
        'acos':   () => { this.genExpr(expr.args[0]); this.ACS_A(); },
        'atan':   () => { this.genExpr(expr.args[0]); this.ATN_A(); },
        'sqrt':   () => { this.genExpr(expr.args[0]); this.SQT_A(); },
        'ln':     () => { this.genExpr(expr.args[0]); this.LNA_A(); },
        'log':    () => { this.genExpr(expr.args[0]); this.LOG_A(); },
        'exp':    () => { this.genExpr(expr.args[0]); this.EEX_A(); },
        'pow10':  () => { this.genExpr(expr.args[0]); this.TNE_A(); },
        'round':  () => { this.genExpr(expr.args[0]); this.ROUN_A(); },
        'floor':  () => { this.genExpr(expr.args[0]); this.FLR_A(); },
        'ceil':   () => { this.genExpr(expr.args[0]); this.CEI_A(); },
        'rand':   () => {
          this.genExpr(expr.args[0]); this.PUSH_A();
          this.genExpr(expr.args[1]);
          const s = this.sym.allocZP('__rand_hi' + this.labelCounter);
          this.STA_zp(s); this.POP_A();
          this.emit(`${op(22)}Z${this.zp(s)};`);
        },
        'randf':  () => {
          this.genExpr(expr.args[0]); this.PUSH_A();
          this.genExpr(expr.args[1]);
          const s = this.sym.allocZP('__randf_hi' + this.labelCounter);
          this.STA_zp(s); this.POP_A();
          this.emit(`${op(23)}Z${this.zp(s)};`);
        },
        'strlen': () => { this.genExpr(expr.args[0]); this.LNG_A(); },
        'strcat': () => {
          this.genExpr(expr.args[0]);
          if (expr.args[1].kind === 'StringLit') this.JOIN_imm(expr.args[1].value);
          else {
            const s = this.sym.allocZP('__strcat_tmp' + this.labelCounter);
            this.PUSH_A();
            this.genExpr(expr.args[1]);
            this.STA_zp(s);
            this.POP_A();
            this.JOIN_zp(s);
          }
        },
        'wait':      () => { this.genExpr(expr.args[0]); this.WAIT_A(); },
        'broadcast': () => {
          if (expr.args[0].kind === 'StringLit') this.MSG(expr.args[0].value);
          else { this.genExpr(expr.args[0]); this.emit(`${op(4)};`); }
        },
        'double': () => { this.genExpr(expr.args[0]); this.DBL_A(); },
        'half':   () => { this.genExpr(expr.args[0]); this.HLF_A(); },
      };

      if (builtins[name]) { builtins[name](); return; }

      // ── Direct named user function call ──
      pushArgs();
      this.JSR(`fn_${name}`);
      return;
    }

    // ── Indirect call ──
    // Push args first, then dispatch based on what holds the pointer
    pushArgs();

    const callee = expr.callee;
    switch (callee.kind) {
      case 'Ident':
        // Variable holding a character offset — use the slot the semantic pass found
        if (callee._slot === undefined)
          throw new CodeGenError(`Cannot call '${callee.name}': no slot assigned`, expr.tok);
        this.JSR_ind_zp(callee._slot);
        break;
      case 'EntityRef':
        // Function pointer stored in an entity component attribute
        this.JSR_ind_ent(callee.entity, callee.comp, callee.attr);
        break;
      case 'SelfRef':
        // Function pointer stored in own component attribute
        this.JSR_ind_self(callee.comp, callee.attr);
        break;
      default:
        throw new CodeGenError(
          `Unsupported indirect call target '${callee.kind}'`, expr.tok);
    }
  }
}

module.exports = { CodeGenerator };
