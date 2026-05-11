import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InMemoryMetadataCache,
  PrismaMetadataCatalogService,
  buildPostgresCatalog,
  buildRelationGraph,
  loadPostgresSchemaCatalog,
  loadPrismaSchemaCatalog,
  parsePrismaSchema,
  searchMetadataCatalog,
  type PostgresColumnRow,
  type PostgresMetadataClient,
  type PostgresQueryRow,
  type PostgresRelationRow,
  summarizeMetadata
} from "../src/index.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(
  currentDir,
  "../../../packages/database/prisma/schema.prisma"
);

describe("metadata-engine", () => {
  it("builds relation edges from id-like columns", () => {
    const relations = buildRelationGraph([
      {
        name: "orders",
        columns: [{ name: "customer_id", dataType: "uuid" }]
      },
      {
        name: "customer",
        columns: [{ name: "id", dataType: "uuid" }]
      }
    ]);

    expect(relations).toEqual([
      {
        fromTable: "orders",
        fromColumn: "customer_id",
        toTable: "customer",
        toColumn: "id"
      }
    ]);
  });

  it("summarizes schema shape", () => {
    const summary = summarizeMetadata([
      { name: "orders", columns: [{ name: "id", dataType: "uuid" }] },
      { name: "customer", columns: [{ name: "id", dataType: "uuid" }] }
    ]);

    expect(summary.tableCount).toBe(2);
    expect(summary.columnCount).toBe(2);
    expect(summary.relationCount).toBe(0);
  });

  it("parses the prisma schema and detects relations", async () => {
    const schemaText = await readFile(schemaPath, "utf8");
    const models = parsePrismaSchema(schemaText);

    expect(models.map((model) => model.name)).toEqual(["Tenant", "AuditLog"]);

    const catalog = await loadPrismaSchemaCatalog(schemaPath);

    expect(catalog.summary.tableCount).toBe(2);
    expect(catalog.summary.columnCount).toBeGreaterThan(0);
    expect(catalog.summary.relationCount).toBe(1);
    expect(catalog.relations).toContainEqual({
      fromTable: "AuditLog",
      fromColumn: "tenantId",
      toTable: "Tenant",
      toColumn: "id"
    });
  });

  it("returns cached catalogs for unchanged schemas", async () => {
    const cache = new InMemoryMetadataCache();
    const first = await loadPrismaSchemaCatalog(schemaPath, cache);
    const second = await loadPrismaSchemaCatalog(schemaPath, cache);

    expect(second).toBe(first);
  });

  it("queries tables and relations through the prisma catalog service", async () => {
    const service = new PrismaMetadataCatalogService({
      sourcePath: schemaPath
    });
    const table = await service.getTable("audit_log");
    const relations = await service.listRelations("Tenant");

    expect(table.name).toBe("AuditLog");
    expect(table.columns.map((column) => column.name)).toContain("tenantId");
    expect(relations).toContainEqual({
      fromTable: "AuditLog",
      fromColumn: "tenantId",
      toTable: "Tenant",
      toColumn: "id"
    });
  });

  it("searches metadata across tables columns and relations", async () => {
    const catalog = await loadPrismaSchemaCatalog(schemaPath);
    const results = searchMetadataCatalog(catalog, "tenant", 5);

    expect(results[0]).toMatchObject({
      tableName: "Tenant",
      score: 100
    });
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "column",
          tableName: "AuditLog",
          columnName: "tenantId"
        }),
        expect.objectContaining({
          type: "relation",
          tableName: "AuditLog"
        })
      ])
    );
  });

  it("rejects empty metadata search queries", async () => {
    const catalog = await loadPrismaSchemaCatalog(schemaPath);

    expect(() => searchMetadataCatalog(catalog, " ")).toThrow("metadata search query is required");
  });

  it("refreshes the catalog through the prisma catalog service", async () => {
    const service = new PrismaMetadataCatalogService({
      sourcePath: schemaPath
    });
    const first = await service.getCatalog();
    const second = await service.refresh();

    expect(second.summary).toEqual(first.summary);
    expect(second.relations).toEqual(first.relations);
  });

  it("builds a catalog from postgres column and relation rows", () => {
    const catalog = buildPostgresCatalog({
      sourcePath: "postgresql://public",
      columns: createPostgresColumns(),
      relations: createPostgresRelations()
    });

    expect(catalog.summary).toEqual({
      tableCount: 2,
      columnCount: 5,
      relationCount: 1
    });
    expect(catalog.tables).toContainEqual({
      name: "orders",
      columns: [
        { name: "id", dataType: "integer" },
        { name: "customer_id", dataType: "integer" },
        { name: "amount", dataType: "numeric" }
      ]
    });
    expect(catalog.relations).toContainEqual({
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id"
    });
  });

  it("loads postgres metadata through a client factory", async () => {
    const client = createFakePostgresClient();
    const catalog = await loadPostgresSchemaCatalog({
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/clusterdata",
      schemaName: "public",
      clientFactory: () => client
    });

    expect(client.connected).toBe(true);
    expect(client.ended).toBe(true);
    expect(client.queries).toHaveLength(2);
    expect(catalog.summary.tableCount).toBe(2);
    expect(catalog.relations).toHaveLength(1);
  });
});

function createPostgresColumns(): readonly PostgresColumnRow[] {
  return [
    {
      table_name: "customers",
      column_name: "id",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
      ordinal_position: 1
    },
    {
      table_name: "customers",
      column_name: "name",
      data_type: "text",
      udt_name: "text",
      is_nullable: "NO",
      ordinal_position: 2
    },
    {
      table_name: "orders",
      column_name: "id",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
      ordinal_position: 1
    },
    {
      table_name: "orders",
      column_name: "customer_id",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
      ordinal_position: 2
    },
    {
      table_name: "orders",
      column_name: "amount",
      data_type: "numeric",
      udt_name: "numeric",
      is_nullable: "NO",
      ordinal_position: 3
    }
  ];
}

function createPostgresRelations(): readonly PostgresRelationRow[] {
  return [
    {
      from_table: "orders",
      from_column: "customer_id",
      to_table: "customers",
      to_column: "id"
    }
  ];
}

function createFakePostgresClient(): PostgresMetadataClient & {
  readonly queries: string[];
  connected: boolean;
  ended: boolean;
} {
  return {
    queries: [],
    connected: false,
    ended: false,
    async connect() {
      this.connected = true;
    },
    async end() {
      this.ended = true;
    },
    async query<T extends PostgresQueryRow>(sql: string): Promise<{ readonly rows: readonly T[] }> {
      this.queries.push(sql);

      if (sql.includes("information_schema.columns")) {
        return { rows: createPostgresColumns() as unknown as readonly T[] };
      }

      return { rows: createPostgresRelations() as unknown as readonly T[] };
    }
  };
}
