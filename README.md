# S# — Scripting Language for the Pressure Wash ECS

**S#** is a statically-structured, C#-style scripting language that compiles to bytecode for the **S# Runtime**. It is designed to be lightweight and fast-terminating, giving you familiar high-level syntax — functions, control flow, typed variables, math — while compiling down to a single flat bytecode string that runs directly inside the **Pressure Wash ECS**.

> **Version 0.01** — Early release. Core language features are implemented and working. See [Known Limitations](#known-limitations).

---

## Features

- C#-style syntax: `fn`, `let`, `const`, `if`, `while`, `for`, structs, and more
- Full recursive function support with a stack-based calling convention
- **Function pointers** — store, pass, and call functions indirectly through variables, arguments, and Pressure Wash ECS component attributes
- Static (persistent) variables with automatic first-run initialization
- Direct Pressure Wash ECS entity/component read-write via `@Component.N` syntax
- Sensing inputs via readable dot-path namespace: `sensing.mouse.x`, `sensing.key.space`, `sensing.time.timer`, etc.
- All S# Runtime math, trig, string, and sensing operations as built-ins
- Import system with circular-import protection and automatic deduplication
- Inline assembly via `asm { }` blocks using opcode names
- Character-accurate jump offset resolution — no off-by-one errors
- Outputs a clean two-line `.sbc` file: static count + single-string bytecode

---

## Requirements

- [Node.js](https://nodejs.org/) v14 or later
- No external dependencies — the compiler is pure Node.js

---

## Installation

Clone the repository and you're ready to go. No build step, no `npm install`.

```bash
git clone https://github.com/KelvinGuy1/S-Sharp-Compiler.git
cd ssharp
```

To make the compiler available as a global command:

```bash
npm link
```

After linking you can use `slc` from anywhere:

```bash
slc myScript.sl -o myScript.sbc
```

---

## Usage

```
node src/compiler.js <input.sl> [-o output.sbc] [--verbose]
```

| Flag | Description |
|------|-------------|
| `-o <file>` | Write output to a file. Defaults to stdout if omitted. |
| `--verbose` / `-v` | Print compilation phase info and instruction count to stderr. |

### Examples

Compile and print to stdout:
```bash
node src/compiler.js src/myscript.sl
```

Compile to a file:
```bash
node src/compiler.js src/myscript.sl -o out/myscript.sbc
```

Compile with verbose output:
```bash
node src/compiler.js src/myscript.sl -o out/myscript.sbc --verbose
```

---

## Output Format

The compiler produces a two-line `.sbc` file:

```
<static variable count>
<bytecode string>
```

**Line 1** is an integer telling the S# Runtime how many zero-page slots to reserve for persistent static variables before running the script.

**Line 2** is the complete bytecode as a single continuous string with no newlines, ready to be stored in a Scratch variable. Jump targets inside the bytecode are **character offsets** into this string.

Static variable initialization — including the user-defined `fn init()` if present — is handled entirely inside the bytecode on first run. The S# Runtime only needs to know the slot count.

---

## Quick Start

```sl
// hello.sl
fn main(): void {
    broadcast "hello_world";
}
```

```bash
node src/compiler.js examples/hello.sl -o out/hello.sbc
```

---

## Language at a Glance

```sl
// Persistent variable — survives between script calls
static let highScore: int = 0;

// Optional first-run setup (statics are already initialized when this runs)
fn init(): void {
    broadcast "game_ready";
}

// Read and write Pressure Wash ECS component attributes directly
fn takeDamage(amount: int): void {
    let hp: int = @Health.0;
    @Health.0 = clamp(hp - amount, 0, 100);
}

fn clamp(val: int, lo: int, hi: int): int {
    if (val < lo) { return lo; }
    if (val > hi) { return hi; }
    return val;
}

// Store a function pointer in a component for virtual dispatch
fn onHit(): void { broadcast "hit"; }

// Entry point
fn main(): void {
    @Behaviour.0 = onHit;   // store fn pointer in ECS component
    takeDamage(25);
    if (@Health.0 <= 0) {
        broadcast "player_dead";
        return;
    }
    if (@Health.0 > highScore) {
        highScore = @Health.0;
    }
    @Behaviour.0();          // call through component fn pointer
}
```

---

## Project Structure

```
ssharp/
├── src/
│   ├── compiler.js   — Entry point and compilation pipeline
│   ├── lexer.js      — Tokenizer
│   ├── parser.js     — Recursive-descent parser / AST builder
│   ├── semantic.js   — Symbol resolution and scope analysis
│   ├── codegen.js    — Bytecode emitter and label resolver
│   └── sensing.js    — Sensing index lookup table
├── examples/
│   ├── fibonacci.sl  — Recursive Fibonacci demo
│   └── ecs_demo.sl   — Pressure Wash ECS demo
├── docs/
│   └── LANGUAGE_REFERENCE.md
└── README.md
```

---

## Documentation

Full language reference, calling convention, memory model, and bytecode mapping:

📄 **[docs/LANGUAGE_REFERENCE.md](docs/LANGUAGE_REFERENCE.md)**

---

## Known Limitations

- **No register allocator.** Zero-page slots are allocated monotonically per-run and never reclaimed. Very large scripts may run low on zero-page space.
- **Static initializers must be literals.** Computed initial values should be handled in `fn init()`.
- **`asm` block slot indices are manual.** `Z#` indices inside `asm { }` must be written as 1-based by hand — the compiler does not adjust them. Sensing in `asm` also uses raw `S#` indices rather than the `sensing.x.y` namespace.
- **Structs are layout-only.** Direct struct instantiation is not yet implemented; use Pressure Wash ECS component addressing.
- **No function pointer type checking.** The compiler does not verify that a stored function pointer matches a particular signature.

---

## Roadmap

- [ ] Register allocator / slot reuse
- [ ] Struct instantiation and member access
- [ ] Type inference
- [ ] Warning system (unused variables, unreachable code)
- [ ] Source maps for runtime error reporting

---

## AI Transperency Disclosure

The source code (just about everything on this repo) was generated by Claude AI. The S# language specification, the S# Runtime, and the Pressure Wash ECS are original work and were not AI-generated.
