# S# Language Reference & Compiler Manual

**Version 1.4** — Targets the S# Runtime (Pressure Wash ECS)

---

## Table of Contents

1. [Overview](#overview)
2. [Output File Format](#output-file-format)
3. [Compiler Usage](#compiler-usage)
4. [Language Syntax](#language-syntax)
   - [Types](#types)
   - [Variables](#variables)
   - [Static Variables](#static-variables)
   - [Functions](#functions)
   - [Structs](#structs)
   - [Control Flow](#control-flow)
   - [Operators](#operators)
   - [Memory Management](#memory-management)
   - [Entity & Component Access](#entity--component-access)
   - [Built-in Functions](#built-in-functions)
   - [Inline Assembly](#inline-assembly)
   - [Sensing](#sensing)
   - [Imports](#imports)
   - [Strings](#strings)
   - [Comments](#comments)
5. [Calling Convention](#calling-convention)
6. [Memory Model](#memory-model)
7. [Bytecode Mapping](#bytecode-mapping)
8. [Limitations & Notes](#limitations--notes)
9. [Full Example Programs](#full-example-programs)

---

## Overview

**S#** (`.sl`) is a statically-structured, C#-style language that compiles to the S# Runtime pseudobytecode. It is designed for use with the **Pressure Wash ECS**. The compiler performs four passes:

1. **Lexing** — tokenizes source text
2. **Parsing** — builds an Abstract Syntax Tree (AST)
3. **Semantic Analysis** — resolves symbols, validates identifiers and scope
4. **Code Generation** — emits pseudobytecode

The entire compiled output is a single flat string with no newline characters inside the bytecode, suitable for storage in a single Scratch variable.

---

## Output File Format

The compiler produces a file with exactly two lines:

```
<static variable count>
<bytecode string>
```

**Line 1** — the total number of static variables in this script, including the hidden `__initialized` flag the compiler injects when statics or `fn init()` are present. The runtime uses this to know how many zero-page slots to reserve before execution.

**Line 2** — the complete bytecode as a single continuous string with no newlines. All jump targets are **character offsets** into this string. Static initial values and first-run logic are handled entirely inside the bytecode (see [Static Variables](#static-variables)).

**Example** (two user statics + one hidden flag = count of 3):
```
3
44I125;00Z4;47I175;00I0;01Z1;...
```

---

## Compiler Usage

```
node src/compiler.js <input.sl> [-o output.sbc] [--verbose]
```

| Flag | Description |
|------|-------------|
| `-o <file>` | Write output to a file instead of stdout |
| `--verbose` / `-v` | Print compilation phase information to stderr |

**Example:**

```bash
node src/compiler.js game.sl -o game.sbc --verbose
```

---

## Language Syntax

### Types

| Type | Description |
|------|-------------|
| `int` | Integer number |
| `float` | Floating-point number |
| `bool` | Boolean (`true` or `false`) |
| `string` | Text string |
| `void` | No return value (functions only) |

Array types are written as `int[]`, `float[]`, etc. Arrays occupy contiguous zero-page slots and are indexed via the X register.

User-defined struct types are declared with `struct` and referenced by name.

---

### Variables

```
let <name> [: <type>] [= <expression>];
const <name> [: <type>] = <expression>;
```

- `let` declares a mutable variable.
- `const` declares an immutable variable.
- The type annotation is optional when an initializer is present. Without either, the type defaults to `int`.

Variables are allocated sequentially in zero-page memory. The zero-page is a Scratch list and is **1-indexed** — the compiler handles this automatically; slot numbers in the bytecode always reflect the correct 1-based index.

Allocation order within a script:

1. **Static variables** — always first, slots 1..N (see below)
2. **Hidden `__initialized` flag** — slot N+1, injected by the compiler when statics or `fn init()` are present
3. **Non-static globals** — follow, in declaration order
4. **Function parameters** — allocated when the function is registered
5. **Local variables** — allocated in order of declaration within their block

**Examples:**

```sl
let x: int = 42;
let y: float = 3.14;
let name: string = "hero";
const MAX_HP: int = 100;
let alive: bool = true;
```

---

### Static Variables

```
static let <name> [: <type>] = <expression>;
static const <name> [: <type>] = <expression>;
```

Static variables are **persistent** — their values survive between script invocations. They live in a dedicated per-entity list on the virtual drive and are loaded into the first N zero-page slots by the runtime before the script runs.

From the bytecode's perspective, static variables are identical to any other zero-page variable — they are read and written with plain `Z#` addressing.

#### First-Run Initialization

Because static variables persist, their initial values must only be written once — on the very first invocation. The compiler handles this automatically by injecting a hidden `__initialized` flag (a static bool, always the last static slot) and wrapping all static initialization in a first-run guard at the top of the entry point:

```
// Pseudocode of what the compiler generates:
if (__initialized == 0) {
    highScore = 0;        // write each static's literal initial value
    playerName = "unknown";
    // ... call fn init() here if user declared one ...
    __initialized = 1;
}
// ... rest of program ...
```

This guard runs on every script invocation but exits immediately after the first time. The static writes always happen first, in declaration order, before any user code in `fn init()` runs.

#### `fn init()`

If you declare a function named `init`, it is called automatically inside the first-run guard, **after** all static initial values have been written. This lets you perform setup that goes beyond simple literal assignment — loading from entities, broadcasting, computing derived values, etc.

```sl
static let highScore: int = 0;
static let playerName: string = "unknown";

fn init(): void {
    // Statics are already set to their declared values by the time this runs.
    // Use this for any additional first-run setup.
    broadcast "first_run";
    @Display.0 = highScore;
}
```

`fn init()` is **never called** on subsequent invocations — it is fully protected by the `__initialized` flag. You cannot call it manually; it is reserved by the compiler.

#### Rules

- Static initializers must be **compile-time literals** (integers, floats, strings, bools). Expressions are not supported as initial values.
- Statics can be declared at the top level or inside functions — either way they are allocated at the front of zero-page and included in the file header count.
- The name `__initialized` is reserved by the compiler.

**Example:**

```sl
static let highScore: int = 0;
static let playerName: string = "unknown";
static const LEVEL_COUNT: int = 10;

fn recordScore(score: int): void {
    if (score > highScore) {
        highScore = score;   // persists after script exits
    }
}
```

---

### Functions

```
fn <name>(<param>: <type>, ...)[: <returnType>] {
    <body>
}
```

Return type defaults to `void` if omitted.

**Modifiers** (placed before `fn` using `@`):

| Modifier | Effect |
|----------|--------|
| `@inline` | Reserved for future use |
| `@static` | Reserved for future optimization |

**Examples:**

```sl
fn add(a: int, b: int): int {
    return a + b;
}

fn greet(): void {
    broadcast "hello";
}
```

Functions compile to subroutines using `JSR` / `RTS`. The `main` function is the program entry point and is called automatically after global initializers run. Function declarations can appear in any order in the file — the compiler emits a jump over all function bodies at the top of the bytecode.

---

### Function Pointers

Functions are first-class values. Use the `fn` type to store a function's address and call it indirectly.

```sl
fn greet(): void { broadcast "hello"; }
fn farewell(): void { broadcast "goodbye"; }

fn main(): void {
    let fp: fn = greet;   // store function address
    fp();                  // indirect call

    fp = farewell;         // reassign
    fp();
}
```

Function pointers can be passed as arguments:

```sl
fn apply(f: fn): void {
    f();
}

fn main(): void {
    apply(greet);
    apply(farewell);
}
```

Function pointers can be stored in Pressure Wash ECS component attributes and called through them — this is the primary mechanism for virtual dispatch and component callbacks in the ECS:

```sl
// Store a behaviour function into an entity's component
@Behaviour.0 = greet;

// Call it later (pointer was stored in the component)
@Behaviour.0();

// Or call through your own component
@MyBehaviour.0 = greet;
@MyBehaviour.0();
```

Under the hood, a function pointer is simply the **character offset** of the function's first instruction in the bytecode string. Storing `greet` into a variable emits `LDA I<offset>;` and calling through it emits `JSR NZ#;` (indirect JSR using `N` addressing), or `JSR NC...;` / `JSR ND...;` for entity and self component targets respectively.

**Note:** There is no type checking on function pointer calls — the compiler does not verify that a stored pointer matches any particular signature. Argument passing follows the same calling convention as direct calls.

---

### Structs

```
struct <Name> {
    <field>: <type>;
    ...
}
```

Structs define named field layouts for documentation and future use. Struct instances are currently accessed via entity/component addressing. Direct struct allocation is a planned feature.

**Example:**

```sl
struct Transform {
    x: float;
    y: float;
    rotation: float;
}
```

---

### Control Flow

#### If / Else

```sl
if (<condition>) {
    // ...
} else if (<condition>) {
    // ...
} else {
    // ...
}
```

Compiles to `JIT` / `JIF` jump instructions with character-offset targets.

#### While

```sl
while (<condition>) {
    // ...
}
```

#### For

```sl
for (let i: int = 0; i < 10; i++) {
    // ...
}
```

All three clauses are optional: `for (;;) { }` is a valid infinite loop.

#### Break and Continue

```sl
while (true) {
    if (done) { break; }
    if (skip) { continue; }
}
```

`break` jumps to the end of the nearest enclosing loop. `continue` jumps to the loop condition (or the post-expression in a `for`).

#### Return

```sl
return;         // void return
return expr;    // return a value (left in A register)
```

---

### Operators

#### Arithmetic

| Operator | Meaning |
|----------|---------|
| `+` | Addition |
| `-` | Subtraction / unary negation |
| `*` | Multiplication |
| `/` | Division |
| `%` | Modulo |

#### Comparison

| Operator | Meaning |
|----------|---------|
| `==` | Equal |
| `!=` | Not equal |
| `<` | Less than |
| `>` | Greater than |
| `<=` | Less than or equal |
| `>=` | Greater than or equal |

Comparison results are `1` (true) or `0` (false) left in A.

#### Logical

| Operator | Meaning |
|----------|---------|
| `&&` | Logical AND (short-circuit) |
| `\|\|` | Logical OR (short-circuit) |
| `!` | Logical NOT |

Short-circuit evaluation is fully implemented.

#### Assignment

| Operator | Meaning |
|----------|---------|
| `=` | Assign |
| `+=` | Add and assign |
| `-=` | Subtract and assign |
| `*=` | Multiply and assign |
| `/=` | Divide and assign |

#### Increment / Decrement

| Form | Effect |
|------|--------|
| `x++` | Post-increment (returns old value) |
| `x--` | Post-decrement (returns old value) |
| `++x` | Pre-increment (returns new value) |
| `--x` | Pre-decrement (returns new value) |

#### Operator Precedence (highest to lowest)

| Level | Operators |
|-------|-----------|
| Postfix | `()` `[]` `.` `++` `--` |
| Unary | `!` `-` `++x` `--x` |
| Multiplicative | `*` `/` `%` |
| Additive | `+` `-` |
| Relational | `<` `>` `<=` `>=` |
| Equality | `==` `!=` |
| Logical AND | `&&` |
| Logical OR | `\|\|` |
| Assignment | `=` `+=` `-=` `*=` `/=` |

---

### Memory Management

S# provides direct access to the zero-page via two built-in statements:

```sl
alloc(n);    // Append n items to zero-page (ALO opcode)
free(expr);  // Delete an item from zero-page (DLO opcode)
```

Because the zero-page is a Scratch list, `ALO` appends items and `DLO` deletes them. Manual tracking of base indices is required for array-style usage.

```sl
alloc(10);           // Reserve 10 contiguous slots
let base: int = 5;   // Track your base index manually
```

---

### Entity & Component Access

S# provides two syntaxes for reading and writing Pressure Wash ECS component attributes directly.

#### Explicit entity reference

```sl
EntityName@ComponentName.attributeIndex
```

- `EntityName` — the target Scratch sprite name
- `ComponentName` — the component list on that sprite
- `attributeIndex` — integer index into the component

```sl
let hp: int = Player@Health.0;   // read
Player@Health.0 = 50;            // write
```

Compiles to `LDA C...` / `STA C...` using `C` addressing.

#### Self reference

```sl
@ComponentName.attributeIndex
```

Refers to the current entity. Compiles to `D` addressing.

```sl
let vel: float = @Physics.1;
@Physics.0 = @Physics.0 + 1.0;
```

---

### Built-in Functions

These compile directly to single bytecode instructions — no call overhead.

#### Math

| Function | Description | Opcode |
|----------|-------------|--------|
| `abs(x)` | Absolute value | `ABS` (28) |
| `sin(x)` | Sine | `SIN` (29) |
| `cos(x)` | Cosine | `COS` (30) |
| `tan(x)` | Tangent | `TAN` (31) |
| `asin(x)` | Arcsine | `ASN` (32) |
| `acos(x)` | Arccosine | `ACS` (33) |
| `atan(x)` | Arctangent | `ATN` (34) |
| `sqrt(x)` | Square root | `SQT` (35) |
| `ln(x)` | Natural log | `LNA` (36) |
| `log(x)` | Log base 10 | `LOG` (37) |
| `exp(x)` | e^x | `EEX` (38) |
| `pow10(x)` | 10^x | `TNE` (39) |
| `round(x)` | Round to nearest int | `ROUN` (25) |
| `floor(x)` | Floor | `FLR` (26) |
| `ceil(x)` | Ceiling | `CEI` (27) |
| `rand(lo, hi)` | Random integer in [lo, hi] | `RAND` (22) |
| `randf(lo, hi)` | Random float in [lo, hi] | `RANF` (23) |
| `double(x)` | Multiply by 2 | `DBL` (7) |
| `half(x)` | Divide by 2 | `HLF` (8) |

#### Strings

| Function | Description | Opcode |
|----------|-------------|--------|
| `strlen(s)` | Length of string | `LNG` (42) |
| `strcat(a, b)` | Concatenate two strings | `JOIN` (40) |

#### Control & Runtime

| Function | Description | Opcode |
|----------|-------------|--------|
| `wait(seconds)` | Pause thread | `WAIT` (11) |
| `broadcast(msg)` | Send a Scratch message | `MSG` (04) |
| `alloc(n)` | Append n slots to zero-page | `ALO` (05) |
| `free(n)` | Delete a slot from zero-page | `DLO` (06) |

#### Cast

```sl
cast<int>(3.7)    // Rounds to 4
cast<float>(5)    // No-op
```

---

### Inline Assembly

For direct bytecode control, use `asm { }` blocks. Write instructions using **opcode names**, not numbers — the compiler resolves them:

```sl
asm {
    RST;           // Reset timer (opcode 57)
    LDA I42;       // Load immediate 42 into A (opcode 00)
    STA Z3;        // Store A to zero-page slot 3 (opcode 01)
}
```

**Opcode names supported in `asm { }`:**

`LDA` `STA` `PUSH` `POP` `MSG` `ALO` `DLO` `DBL` `HLF` `INC` `DEC` `WAIT`
`AND` `ORA` `NOT` `CGR` `CLS` `CEQ` `ADD` `SUB` `MUL` `DIV` `RAND` `RANF`
`MOD` `ROUN` `FLR` `CEI` `ABS` `SIN` `COS` `TAN` `ASN` `ACS` `ATN` `SQT`
`LNA` `LOG` `EEX` `TNE` `JOIN` `LTR` `LNG` `SCT` `JMP` `JSR` `RTS` `JIT`
`JIF` `JST` `JSF` `LDX` `STX` `RST`

Addressing suffixes follow immediately after the opcode name with no space before the operand content:

```sl
asm {
    LDA I100;      // immediate
    STA Z2;        // zero-page slot 2 (note: Z indices in asm are NOT auto-adjusted
                   // for 1-indexing — write the 1-based index directly)
    LDA S11;       // sense index 11 (timer)
    LDA DHealth.0; // self component read
}
```

> **Warning:** Inline assembly bypasses all type checking, scope, and safety guarantees. Zero-page slot indices written in `asm` blocks must be 1-based manually — the compiler does not adjust them. Make sure the A register and stack are in a consistent state when entering and leaving an `asm` block.

---

### Sensing

Scratch's sensing inputs are accessed through the `sensing` namespace using dot-path syntax: `sensing.<category>.<name>`. These are expressions — use them anywhere a value is expected.

```sl
let mx: int      = sensing.mouse.x;
let clicked: bool = sensing.mouse.down;
let space: bool  = sensing.key.space;
let t: float     = sensing.time.timer;
let yr: int      = sensing.time.year;
let who: string  = sensing.user.name;

if (sensing.key.up) {
    @Physics.1 = @Physics.1 + 1;
}
wait(sensing.time.second);
```

Each `sensing.x.y` expression compiles to a single `LDA S#` instruction.

#### `sensing.mouse`

| Name | Description |
|------|-------------|
| `sensing.mouse.x` | Mouse X position |
| `sensing.mouse.y` | Mouse Y position |
| `sensing.mouse.down` | Mouse button held |

#### `sensing.mic`

| Name | Description |
|------|-------------|
| `sensing.mic.loudness` | Microphone loudness |

#### `sensing.time`

| Name | Description |
|------|-------------|
| `sensing.time.year` | Current year |
| `sensing.time.month` | Current month |
| `sensing.time.day` | Current day of month |
| `sensing.time.weekday` | Current weekday (1 = Sunday) |
| `sensing.time.hour` | Current hour |
| `sensing.time.minute` | Current minute |
| `sensing.time.second` | Current second |
| `sensing.time.timer` | Timer value (float) |
| `sensing.time.daysSince2000` | Days since Jan 1 2000 |

#### `sensing.user`

| Name | Description |
|------|-------------|
| `sensing.user.name` | Scratch username |
| `sensing.user.online` | Online status |

#### `sensing.key`

| Name | Description |
|------|-------------|
| `sensing.key.any` | Any key pressed |
| `sensing.key.space` | Space bar |
| `sensing.key.up` | Up arrow |
| `sensing.key.down` | Down arrow |
| `sensing.key.left` | Left arrow |
| `sensing.key.right` | Right arrow |
| `sensing.key.a` – `sensing.key.z` | Letter keys |
| `sensing.key.k1` – `sensing.key.k0` | Number keys 1–0 |
| `sensing.key.exclaim` | `!` |
| `sensing.key.at` | `@` |
| `sensing.key.hash` | `#` |
| `sensing.key.dollar` | `$` |
| `sensing.key.percent` | `%` |
| `sensing.key.caret` | `^` |
| `sensing.key.amp` | `&` |
| `sensing.key.star` | `*` |
| `sensing.key.lparen` | `(` |
| `sensing.key.rparen` | `)` |
| `sensing.key.lbracket` | `[` |
| `sensing.key.rbracket` | `]` |
| `sensing.key.lbrace` | `{` |
| `sensing.key.rbrace` | `}` |
| `sensing.key.lt` | `<` |
| `sensing.key.gt` | `>` |
| `sensing.key.slash` | `/` |
| `sensing.key.backslash` | `\` |
| `sensing.key.pipe` | `\|` |
| `sensing.key.comma` | `,` |
| `sensing.key.dot` | `.` |
| `sensing.key.question` | `?` |
| `sensing.key.semicolon` | `;` |
| `sensing.key.colon` | `:` |
| `sensing.key.quote` | `'` |
| `sensing.key.dquote` | `"` |
| `sensing.key.minus` | `-` |
| `sensing.key.plus` | `+` |
| `sensing.key.equals` | `=` |
| `sensing.key.underscore` | `_` |
| `sensing.key.backtick` | `` ` `` |
| `sensing.key.tilde` | `~` |

---

### Imports

Use `import` to pull in other `.sl` files. The compiler merges all imported files into a single translation unit before compiling.

```sl
import "path/to/file.sl";
```

Paths are resolved relative to the importing file. Absolute paths are also accepted.

```sl
// main.sl
import "lib/math.sl";
import "lib/physics.sl";

fn main(): void {
    let v: float = lerp(0.0, 10.0, 0.5);   // defined in math.sl
    applyGravity();                           // defined in physics.sl
}
```

**Rules:**
- Imports are hoisted — the imported file's declarations are available throughout the importing file regardless of where the `import` statement appears.
- Circular imports are safe — if file A imports file B and file B imports file A, each file is only included once.
- Duplicate imports of the same file are silently deduplicated.
- All functions, globals, and statics from imported files share the same zero-page address space as the importing file.
- `import` statements are only valid at the top level, not inside functions or blocks.

---

### Strings

String literals use double-quote syntax:

```sl
let msg: string = "Hello, world!";
broadcast "game_over";
```

| Escape | Character |
|--------|-----------|
| `\n` | Newline |
| `\t` | Tab |
| `\r` | Carriage return |
| `\\` | Backslash |
| `\"` | Double quote |

---

### Comments

```sl
// Single-line comment

/*
   Multi-line comment
*/
```

---

## Calling Convention

S# uses a **stack-based calling convention**. The stack is a separate Scratch list managed entirely by the runtime — it is never accessed by index, only through `PUSH`, `POP`, `JSR`, and `RTS`.

1. The **caller** evaluates each argument left-to-right, pushing each result onto the stack with `PUSH`.
2. The **callee** pops arguments in **reverse order** (right-to-left) into its zero-page parameter slots with `POP Z#`.
3. The **return value** is left in the **A register** at `RTS`.
4. The caller does not need to clean the stack — arguments were consumed by the callee.

**Example — `add(3, 5)`:**

```
LDA I3;      // load first arg
PUSH;        // push it
LDA I5;      // load second arg
PUSH;        // push it
JSR I<add>;  // call (pushes return address internally)
// A now holds the return value
```

Inside `add`:
```
POP Z2;      // b <- stack (second param, slot 2)
POP Z1;      // a <- stack (first param, slot 1)
// ... body ...
RTS;         // pops return address internally
```

---

## Memory Model

### Zero-Page

The zero-page is a flat Scratch list used as the script's working RAM. It is **1-indexed** — slot numbers in emitted bytecode always reflect this. The compiler tracks slots internally as 0-based and adds 1 at the point of emission, so you never need to think about the offset in S# source code.

**Allocation order:**

| Range | Contents |
|-------|----------|
| Slots 1..N | Static variables (pre-loaded by runtime before execution) |
| Slots N+1.. | Non-static globals, then params and locals in declaration order |

Slots are allocated monotonically and never reclaimed within a single script run.

### Stack

The stack is a **separate** Scratch list, fully managed by the runtime. It is only accessible through:

- `PUSH` — push A onto the stack
- `POP` — pop from the stack into A or a zero-page slot
- `JSR` — push return address and jump
- `RTS` — pop return address and jump back

No index into the stack is ever emitted by the compiler.

### Jump Targets

All jump and subroutine opcodes (`JMP`, `JSR`, `JIT`, `JIF`, `JST`, `JSF`) take a **character offset** into the bytecode string on line 3 of the output file. The compiler resolves these using an iterative fixed-point pass: it renders all instructions, measures the character position of each one, updates all label targets, and repeats until stable (typically 2–3 iterations to handle cases where a target's digit count changes, e.g. crossing from offset 99 to 100).

### X Register

Used for array indexing via `Y`-addressing. When you write `arr[i]`:

```
// i loaded into A
LDX;          // transfer A to X
LDA Y<base>;  // read zero-page[base + X]
```

---

## Bytecode Mapping

Key S# constructs and their emitted bytecode. `Z#` indices shown are 1-based as they appear in the output.

| S# | Bytecode |
|----|---------|
| `let x = 5;` | `00I5;01Z#x;` |
| `x = y;` | `00Z#y;01Z#x;` |
| `a + b` (general) | `00Z#a;02;00Z#b;01Z#tmp;03;18Z#tmp;` |
| `a + 5` (immediate RHS) | `00Z#a;18I5;` |
| `a > b` | `00Z#a;02;00Z#b;01Z#tmp;03;15Z#tmp;` |
| `!x` | `00Z#x;14;` |
| `if (c) { }` | `[c];48I<charOffset>;[then];` |
| `while (c) { }` | `[c];48I<end>;[body];44I<top>;` |
| `foo(a, b)` | `[a];02;[b];02;45I<charOffset>;` |
| `return x;` | `00Z#x;44I<retCharOffset>;` |
| `broadcast "msg"` | `04I"msg";` |
| `wait(t)` | `[t];11;` |
| `@Comp.0` (read) | `00DComp.0;` |
| `E@Comp.1 = v;` (write) | `[v];01CE.Comp.1;` |
| `sense(11)` | `00S11;` |
| `sqrt(x)` | `[x];35;` |
| `alloc(n)` | `[n];05;` |
| `let fp: fn = foo;` | `00I<charOffset>;01Z#fp;` |
| `fp()` | `45NZ#fp;` |
| `@Comp.0()` | `45NDComp.0;` |
| `Entity@Comp.0()` | `45NCEntity.Comp.0;` |
| `static let s = 0;` | *(slot reserved at front of ZP; initial value written by compiler-generated first-run guard)* |

---

## Limitations & Notes

### Current Limitations

- **No register allocator.** Zero-page slots are allocated monotonically and never reclaimed. Very large programs or deeply recursive ones may exhaust zero-page space.
- **No type inference.** Omitting the type annotation defaults to `int`. Explicit types are recommended.
- **Static initializers must be literals.** The initial value in a `static let` declaration must be a compile-time constant (integer, float, string, or bool). For computed initial values, declare the static with a safe default and perform the real initialization inside `fn init()`.
- **Structs are layout-only.** `struct` declarations exist for documentation. Instances are currently accessed through entity/component addressing.
- **No indirect calls.** Function pointers and virtual dispatch are not supported.
- **`asm` block slot indices are manual.** The compiler does not adjust `Z#` indices inside `asm { }` for 1-indexing — you must write the correct 1-based index yourself. Similarly, sensing in `asm` still uses raw `S#` indices rather than the `sensing.x.y` namespace.
- **Destructive math ops.** Opcodes 7–10, 14, and 35–39 are destructive to input addresses. The compiler loads values into A before calling these to avoid clobbering the source slot.

### Tips

- `static` variables are the right tool for anything that needs to persist between invocations — scores, state machines, counters.
- Entity references (`@Component.N`) emit a single instruction with no intermediate zp allocation — prefer them over locals for tight loops touching component data.
- Short-circuit `&&` and `||` are safe to use; the right-hand side is skipped when unnecessary.
- Use `asm { }` for opcodes not yet surfaced in the language: `RST` (timer reset), `LTR` (string character access), `SCT` (string contains), and others.
- Split shared utilities (math helpers, physics, etc.) into their own `.sl` files and `import` them — circular imports are safe and duplicates are deduplicated automatically.

---

## Full Example Programs

### Fibonacci (Recursive)

```sl
fn fibonacci(n: int): int {
    if (n <= 1) {
        return n;
    }
    return fibonacci(n - 1) + fibonacci(n - 2);
}

fn main(): void {
    let result: int = fibonacci(10);
    @Output.0 = result;
    broadcast "fib_done";
}
```

### Health System with Persistent High Score

```sl
static let highScore: int = 0;

fn clamp(val: int, lo: int, hi: int): int {
    if (val < lo) { return lo; }
    if (val > hi) { return hi; }
    return val;
}

fn applyDamage(damage: int): void {
    let hp: int = @Health.0;
    @Health.0 = clamp(hp - damage, 0, 100);
}

fn recordScore(score: int): void {
    if (score > highScore) {
        highScore = score;
    }
}

fn main(): void {
    @Health.0 = 100;
    applyDamage(35);
    applyDamage(50);
    if (@Health.0 > 0) {
        broadcast "player_alive";
    } else {
        broadcast "player_dead";
    }
    recordScore(42);
}
```

### Input Loop with Sensing

```sl
fn waitForKey(keyIndex: int): void {
    while (!sense(keyIndex)) {
        wait(0.05);
    }
}

fn main(): void {
    broadcast "waiting";
    waitForKey(16);       // space bar
    broadcast "space_pressed";
    waitForKey(17);       // up arrow
    broadcast "up_pressed";
}
```

### Timer Reset via Inline Assembly

```sl
fn resetAndWait(seconds: float): void {
    asm {
        RST;
    }
    wait(seconds);
}

fn main(): void {
    resetAndWait(2.0);
    broadcast "timer_done";
}
```

---

*S# Compiler — built for the S# Runtime and the Pressure Wash ECS.*
