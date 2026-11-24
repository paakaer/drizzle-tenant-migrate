CREATE SCHEMA "tenant";
--> statement-breakpoint
CREATE TYPE "tenant"."order_status" AS ENUM('new', 'done');--> statement-breakpoint
CREATE SEQUENCE "tenant"."orders_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "tenant"."customers" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"customer_id" integer,
	"status" "tenant"."order_status" DEFAULT 'new'::"tenant"."order_status"
);
--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "tenant"."orders" ("customer_id");--> statement-breakpoint
ALTER TABLE "tenant"."orders" ADD CONSTRAINT "orders_customer_id_customers_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "tenant"."customers"("id");