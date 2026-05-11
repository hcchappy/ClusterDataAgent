import { AppError } from "@clusterdata/shared";

export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  execute(input: TInput): Promise<TResult> | TResult;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  public register<TInput, TResult>(tool: ToolDefinition<TInput, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new AppError(
        `Tool already registered: ${tool.name}`,
        "TOOL_ALREADY_REGISTERED",
        409
      );
    }

    this.tools.set(tool.name, tool);
  }

  public list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public async execute<TInput, TResult>(
    name: string,
    input: TInput
  ): Promise<TResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new AppError(`Unknown tool: ${name}`, "UNKNOWN_TOOL", 404);
    }

    return (await tool.execute(input)) as TResult;
  }
}
