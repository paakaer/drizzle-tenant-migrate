CREATE SCHEMA "tenant";
--> statement-breakpoint
CREATE TYPE "tenant"."order_status" AS ENUM('new', 'done');--> statement-breakpoint
CREATE SEQUENCE "tenant"."orders_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "tenant"."customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" integer,
	"status" "tenant"."order_status" DEFAULT 'new'
);
--> statement-breakpoint
ALTER TABLE "tenant"."orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "tenant"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "tenant"."orders" USING btree ("customer_id");