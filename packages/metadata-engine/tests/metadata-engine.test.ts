import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMetadataCatalogInsights,
  buildSemanticCatalogInsights,
  buildSemanticMetricQuery,
  InMemoryMetadataCache,
  InMemorySemanticCatalogCache,
  PrismaMetadataCatalogService,
  SemanticCatalogService,
  buildPostgresCatalog,
  buildRelationGraph,
  loadPostgresSchemaCatalog,
  loadPrismaSchemaCatalog,
  loadSemanticCatalog,
  parsePrismaSchema,
  searchMetadataCatalog,
  searchSemanticCatalog,
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
const semanticCatalogPath = resolve(
  currentDir,
  "../../../packages/database/semantic/catalog.json"
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

  it("builds metadata catalog insights for workbench exploration", async () => {
    const catalog = await loadPrismaSchemaCatalog(schemaPath);
    const insights = buildMetadataCatalogInsights(catalog, {
      tableLimit: 2,
      columnLimit: 2
    });

    expect(insights.summary).toEqual(catalog.summary);
    expect(insights.dataTypes.length).toBeGreaterThan(0);
    expect(insights.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "AuditLog",
          relationCount: 1,
          starterQuery: "select id, tenantId from AuditLog limit 20"
        }),
        expect.objectContaining({
          tableName: "Tenant",
          relationCount: 1
        })
      ])
    );
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

  it("loads and caches the semantic catalog against the prisma metadata catalog", async () => {
    const metadataCatalog = await loadPrismaSchemaCatalog(schemaPath);
    const cache = new InMemorySemanticCatalogCache();
    const first = await loadSemanticCatalog(semanticCatalogPath, metadataCatalog, cache);
    const second = await loadSemanticCatalog(semanticCatalogPath, metadataCatalog, cache);

    expect(first.summary).toEqual({
      modelCount: 2,
      metricCount: 3,
      dimensionCount: 7,
      ownerCount: 2
    });
    expect(first.metrics.map((metric) => metric.id)).toContain("tenant_count");
    expect(second).toBe(first);
  });

  it("searches the semantic catalog across models dimensions and metrics", async () => {
    const metadataCatalog = await loadPrismaSchemaCatalog(schemaPath);
    const catalog = await loadSemanticCatalog(semanticCatalogPath, metadataCatalog);
    const metricResults = searchSemanticCatalog(catalog, "租户数", 5);
    const dimensionResults = searchSemanticCatalog(catalog, "action", 5);

    expect(metricResults[0]).toMatchObject({
      type: "metric",
      id: "tenant_count",
      modelId: "tenant"
    });
    expect(dimensionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dimension",
          id: "auditLog.action",
          tableName: "AuditLog"
        })
      ])
    );
  });

  it("builds semantic metric sql with dimensions and time grain", async () => {
    const metadataCatalog = await loadPrismaSchemaCatalog(schemaPath);
    const catalog = await loadSemanticCatalog(semanticCatalogPath, metadataCatalog);
    const query = buildSemanticMetricQuery(catalog, {
      metricIds: ["audit_log_count"],
      dimensionIds: ["auditLog.action"],
      timeGrain: "day",
      limit: 30
    });

    expect(query.metricIds).toEqual(["audit_log_count"]);
    expect(query.dimensionIds).toEqual(["auditLog.action", "auditLog.createdAt"]);
    expect(query.sql).toContain(`date_trunc('day', "createdAt") as "auditLog_createdAt_day"`);
    expect(query.sql).toContain(`count("id") as "audit_log_count"`);
    expect(query.sql).toContain('from "AuditLog"');
    expect(query.sql).toContain('group by "action", date_trunc(\'day\', "createdAt")');
    expect(query.referencedColumns).toEqual(
      expect.arrayContaining(["AuditLog.id", "AuditLog.action", "AuditLog.createdAt"])
    );
  });

  it("builds semantic insights for workbench exploration", async () => {
    const metadataCatalog = await loadPrismaSchemaCatalog(schemaPath);
    const catalog = await loadSemanticCatalog(semanticCatalogPath, metadataCatalog);
    const insights = buildSemanticCatalogInsights(catalog, {
      modelLimit: 2,
      metricLimit: 2
    });

    expect(insights.summary).toEqual(catalog.summary);
    expect(insights.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: "auditLog",
          metricCount: 2
        }),
        expect.objectContaining({
          modelId: "tenant",
          metricCount: 1
        })
      ])
    );
    expect(insights.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: "platform",
          modelCount: 1,
          metricCount: 1
        })
      ])
    );
  });

  it("queries semantic data through the semantic catalog service", async () => {
    const metadataCatalog = await loadPrismaSchemaCatalog(schemaPath);
    const semanticService = new SemanticCatalogService({
      sourcePath: semanticCatalogPath,
      getMetadataCatalog: () => metadataCatalog,
      initialCatalog: await loadSemanticCatalog(semanticCatalogPath, metadataCatalog)
    });
    const searchResults = await semanticService.search("audit", 5);
    const query = await semanticService.buildMetricQuery({
      metricIds: ["tenant_count"],
      dimensionIds: ["tenant.name"],
      limit: 10
    });

    expect(searchResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "model",
          id: "auditLog"
        })
      ])
    );
    expect(query.sql).toContain('select "name" as "tenant_name"');
    expect(query.sql).toContain('count("id") as "tenant_count"');
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
