// S# Example: Pressure Wash ECS Demo
// Shows Pressure Wash ECS entity/component access, loops, and sensing

// A simple "health component" update system
fn clamp(val: int, lo: int, hi: int): int {
    if (val < lo) { return lo; }
    if (val > hi) { return hi; }
    return val;
}

fn applyDamage(damage: int): void {
    let hp: int = @Health.0;
    hp = hp - damage;
    hp = clamp(hp, 0, 100);
    @Health.0 = hp;
}

fn isAlive(): bool {
    return @Health.0 > 0;
}

fn heal(amount: int): void {
    let hp: int = @Health.0;
    @Health.0 = clamp(hp + amount, 0, 100);
}

// Physics-like loop: apply gravity to a list of entities
fn applyGravity(entityCount: int): void {
    let i: int = 0;
    while (i < entityCount) {
        let vel: int = @Physics.1;   // velocity Y component
        vel = vel - 1;               // gravity constant
        @Physics.1 = vel;
        i++;
    }
}

// Dot product of two 3-component vectors stored starting at baseA and baseB
fn dot3(baseA: int, baseB: int): float {
    let ax: float = @Math.0;
    let ay: float = @Math.1;
    let az: float = @Math.2;
    let bx: float = @Math.3;
    let by: float = @Math.4;
    let bz: float = @Math.5;
    return ax * bx + ay * by + az * bz;
}

// Wait for a key press before continuing
fn waitForSpace(): void {
    let pressed: bool = false;
    while (!pressed) {
        pressed = sense(16);   // sense index 16 = space key
        wait(0.05);
    }
}

fn main(): void {
    // Initialize health to full
    @Health.0 = 100;

    // Take some damage
    applyDamage(30);
    applyDamage(45);

    // Heal a bit
    heal(20);

    // Check if alive and broadcast result
    if (isAlive()) {
        broadcast "player_alive";
    } else {
        broadcast "player_dead";
    }

    // Inline assembly for a direct timer reset
    asm {
        57RST;
    }

    waitForSpace();
    broadcast "level_start";
}
