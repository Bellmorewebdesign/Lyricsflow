/** Keep remote commands in their received order when page injection is async. */
export class CommandQueue {
  private previous: Promise<void> = Promise.resolve();
  run<T>(command: () => Promise<T>): Promise<T> {
    const result = this.previous.then(command);
    this.previous = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
