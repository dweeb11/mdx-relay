/** Minimal runtime used only when Vitest imports the production plugin entry. */
export class Plugin {
  addCommand(command: unknown): void {
    void command;
  }

  register(callback: () => unknown): void {
    void callback;
  }
}
