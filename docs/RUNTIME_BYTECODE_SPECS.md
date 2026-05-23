This is the initial bytecode specifications for the PressureWash ECS S# runtime. This documentation is what was used to create the S# programming language, and can be used by developers to create thier own programming language. This is the one part also not vibecoded if you want to spite-code a human made programming language (do it I dare you >:3).

Of these specs it's noted, a compiled script MUST fit in a single scratch variable. The S# runtime runs the code from this variable. The program can run multiple player scripts at once with the help of clones and you can specify in PressureWash how many opcodes run per frame (at scratch's 30 fps cap).

Opcodes
00-LDA Load address to A
01-STA Store address from A to an input
02-PUSH (Push A/Input to stack)
03-POP (Pop from stack to A or to an output)
04-MSG (Broadcast message block in scratch)
05-ALO (Allocate (Add X items to the zeropage (Leave blank to use A as input))
06-DLO (Deallocate(Delete) item from zeropage (Leave blank to use A as input))
07-DBL (Double A or input)
08-HLF (Halves A or input)
09-INC (Increments A or input by 1)
10-DEC (Decrement A or input by 1)
11-WAIT (halts thread for A/input seconds)
12-AND (Assumes A and Input are bools, Result is left in A)
13-ORA (Assumes A and Input are bools, Result is left in A)
14-NOT (Assumes A or Input is bools)
15-CGR (Greater?) (A>INPUT) Result is left in A
16-CLS (Less?) (A<INPUT) Result is left in A
17-CEQ (Equal?) (A=INPUT) Result is left in A
18-ADD (A+Input) Result is left in A
19-SUB (A-Input) Result is left in A
20-MUL (A*Input) Result is left in A
21-DIV (A/Input) Result is left in A
22-RAND (Random integer between A and input)
23-RANF (Random float between A and input)
24-MOD (input mod A)
25-ROUN (Round input (leave empty for a))
26-FLR (Floor input (leave empty for a))
27-CEI (Ceiling input (leave empty for a))
28-ABS (Absolute input (leave empty for a))
29-SIN (Sin input (leave empty for a))
30-COS (Cos input (leave empty for a))
31-TAN (Round input (leave empty for a))
32-ASN (Round input (leave empty for a))
33-ACS (Round input (leave empty for a))
34-ATN (Round input (leave empty for a))
35-SQT (Round input (leave empty for a))
36-LNA (LN input (leave empty for a))
37-LOG (logarithm of input (leave empty for a))
38-EEX (E^input (leave empty for a))
39-TNE (10^input (leave empty for a))
40-JOIN (String in A + String in input)
41-LTR (Letter A of String)
42-LNG (Round input (leave empty for a))
43-SCT (String contains)
44-JMP Sets program counter
45-JSR Pushes program counter to stack and jumps to new number
46-RTS Pops from stack to program counter
47-JIT Jump to address if A is true
48-JIF Jump to address if A is false
49-JST Pushes program counter to stack and jumps to new number if A is true
50-JSF Pushes program counter to stack and jumps to new number if A is false
51-LDX
52-STX
57-RST Reset timer

Instructions look like the following:
42I"The quick brown fox jumped over the lazy dog.";

42 -> 2 digit instruction
I -> Data type letter
"The quick brown fox jumped over the lazy dog." -> Contents
; -> End of instruction (will not trigger if within quotes)

Data/addressing types
Nothing - Usually does function with whatever is in A
I[# or string here] - Immediate input. Make sure text is in quotes `', it can work without, but it's generally bad practice if you want to include semicolon. Note also the strings are processed without quotes.
Z# - Read/Write item number from zero page.
Y#- Read/Write item number from offset in zero page + Whatever is in X (good for arrays).
X - Read/Write/Modify X
CEntityName.ComponentName.AttributeIndex - Read/Write to entity
DComponentName.AttributeIndex - Read/Write to entity (implicit self)
S# - Read a value from the sensing category, see sensing index for list
N[Addressing data] - Uses the contents (in the format types above) to address indirectly (requires the data addressing type of the original value). For example if X contains I`The quick brown fox jumped over the lazy dog.', NX will result in The quick brown fox jumped over the lazy dog. being the data read.

Note: The script is not addressable and arrays are not supported. You have to manually write the arrays to zero page.

Functions 7-10, 14, and 35-39 are destructive to any input addresses. If you don't want them to affect actual addresses load the value to A and do the function without an input.

Sensing index:
0 - Mouse X
1 - Mouse Y
2 - Mouse Down
3 - Microphone Loudness
4 - Current Year
5 - Current Month
6 - Current Day Of the Month
7 - Current Weekday (1 = Sunday)
8 - Current Hour
9 - Current Minute
10 - Current Second
11 - Timer
12 - Days Since 2000
13 - Scratch Username
14 - Online?
15 - Any key pressed
16 - Space key
17 - Up key
18 - Down key
19 - Left key
20 - Right key
21-46 - a-z keys
47-57 - 1-0 number keys
58-89 - Character keys in the following order !@#$%^&*()[]{}<>/\|,.?;:'"-+=_`~
