// S# Example: Fibonacci
// Demonstrates recursion, int math, and return values

fn fibonacci(n: int): int {
    if (n <= 1) {
        return n;
    }
    return fibonacci(n - 1) + fibonacci(n - 2);
}

fn main(): void {
    let result: int = fibonacci(10);
    // Store result to entity attribute
    @MyComponent.0 = result;
    broadcast "fib_done";
}
