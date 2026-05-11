import { AppError } from "@clusterdata/shared";

export interface TableColumn {
  readonly name: string;
  readonly dataType: string;
}

export interface TableDefinition {
  readonly name: string;
  readonly columns: readonly TableColumn[];
}

export interface RelationEdge {
  readonly fromTable: string;
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

export function summarizeMetadata(tables: readonly TableDefinition[]): {
  readonly tableCount: number;
  readonly columnCount: number;
  readonly relationCount: number;
} {
  if (tables.length === 0) {
    throw new AppError("No tables provided", "NO_TABLES", 400);
  }

  const relationCount = buildRelationGraph(tables).length;

  return {
    tableCount: tables.length,
    columnCount: tables.reduce((sum, table) => sum + table.columns.length, 0),
    relationCount
  };
}

export function buildRelationGraph(
  tables: readonly TableDefinition[]
): readonly RelationEdge[] {
  const tablesByName = new Map(tables.map((table) => [table.name, table]));
  const relations: RelationEdge[] = [];

  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.name.endsWith("_id")) {
        continue;
      }

      const candidateTable = column.name.slice(0, -3);
      const target = tablesByName.get(candidateTable);

      if (!target) {
        continue;
      }

      relations.push({
        fromTable: table.name,
        fromColumn: column.name,
        toTable: target.name,
        toColumn: "id"
      });
    }
  }

  return relations;
}

