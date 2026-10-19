import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** All reads and writes require the authenticated Sites user ID plus a progress key. */
export const progressRecords = sqliteTable("progress_records", {
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  valueJson: text("value_json").notNull(),
  version: integer("version").notNull(),
  updatedAt: text("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.key] })]);
