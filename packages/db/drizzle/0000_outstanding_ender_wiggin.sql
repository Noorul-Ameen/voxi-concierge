CREATE TABLE "cinema_operators" (
	"cinema_id" varchar(8) NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"experience" varchar(32) NOT NULL,
	CONSTRAINT "cinema_operators_cinema_id_code_pk" PRIMARY KEY("cinema_id","code")
);
--> statement-breakpoint
CREATE TABLE "cinemas" (
	"id" varchar(8) PRIMARY KEY NOT NULL,
	"cinema_national_id" varchar(32) DEFAULT '',
	"name" text NOT NULL,
	"name_alt" text DEFAULT '',
	"phone_number" text DEFAULT '',
	"email_address" text DEFAULT '',
	"address1" text DEFAULT '',
	"address2" text DEFAULT '',
	"city" text DEFAULT '',
	"latitude" text DEFAULT '',
	"longitude" text DEFAULT '',
	"parking_info" text DEFAULT '',
	"loyalty_code" varchar(8) DEFAULT '',
	"is_gift_store" boolean DEFAULT false,
	"description" text DEFAULT '',
	"description_alt" text,
	"public_transport" text DEFAULT '',
	"currency_code" varchar(3) DEFAULT 'AED' NOT NULL,
	"allow_print_at_home" boolean DEFAULT false,
	"allow_online_voucher" boolean DEFAULT true,
	"display_sofa_seats" boolean DEFAULT false,
	"time_zone_id" text DEFAULT 'Arabian Standard Time',
	"hopk" varchar(8) DEFAULT '',
	"server_name" text DEFAULT '',
	"slug" text NOT NULL,
	"mall_name" text DEFAULT '',
	"emirate" text DEFAULT '',
	"short_code" varchar(8) DEFAULT '',
	"opening_hours" jsonb DEFAULT '[]'::jsonb,
	"accessibility_info" text DEFAULT '',
	"in_mall_directions" text DEFAULT '',
	"in_mall_directions_alt" text DEFAULT '',
	"best_parking" text DEFAULT '',
	"experiences" jsonb DEFAULT '[]'::jsonb,
	"website_url" text DEFAULT '',
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "film_genres" (
	"id" varchar(10) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_translations" jsonb DEFAULT '[]'::jsonb,
	"description" text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE "films" (
	"ho_code" varchar(12) PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"title_alt" text DEFAULT '',
	"rating" varchar(12) DEFAULT '',
	"rating_description" text DEFAULT '',
	"rating_description_alt" text DEFAULT '',
	"synopsis" text DEFAULT '',
	"synopsis_alt" text DEFAULT '',
	"opening_date" timestamp,
	"run_time" integer DEFAULT 0,
	"trailer_url" text DEFAULT '',
	"genre_ids" jsonb DEFAULT '[]'::jsonb,
	"genre_names" jsonb DEFAULT '[]'::jsonb,
	"cast" jsonb DEFAULT '[]'::jsonb,
	"language" text DEFAULT '',
	"subtitles" text DEFAULT '',
	"poster_url" text DEFAULT '',
	"hero_url" text DEFAULT '',
	"slug" text DEFAULT '',
	"website_url" text DEFAULT '',
	"status" varchar(16) DEFAULT 'now_showing' NOT NULL,
	"is_scheduled_at_cinema" boolean DEFAULT true NOT NULL,
	"source_hash" text DEFAULT '',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_films" (
	"cinema_id" varchar(8) NOT NULL,
	"ho_code" varchar(12) NOT NULL,
	"first_showtime" timestamp,
	"last_showtime" timestamp,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_films_cinema_id_ho_code_pk" PRIMARY KEY("cinema_id","ho_code")
);
--> statement-breakpoint
CREATE TABLE "session_attributes" (
	"id" varchar(10) PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"short_name" text NOT NULL,
	"alt_description" text DEFAULT '',
	"alt_short_name" text DEFAULT '',
	"message" text DEFAULT '',
	"sales_channels" text DEFAULT '|IVR|CALL|WWW|KIOSK|CELL|PDA|POS|POSBK|RSP|',
	"is_used_for_concepts" boolean DEFAULT false,
	"is_used_for_session_advertising" boolean DEFAULT true,
	"display_priority" integer DEFAULT 100
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"cinema_id" varchar(8) NOT NULL,
	"session_id" varchar(16) NOT NULL,
	"ho_code" varchar(12) NOT NULL,
	"showtime" timestamp NOT NULL,
	"session_business_date" date NOT NULL,
	"screen_name" text NOT NULL,
	"screen_number" integer DEFAULT 1 NOT NULL,
	"cinema_operator_code" varchar(16) NOT NULL,
	"experience" varchar(32) NOT NULL,
	"format_code" varchar(10) DEFAULT '0000000001',
	"attribute_ids" jsonb DEFAULT '[]'::jsonb,
	"area_category_codes" jsonb DEFAULT '["0000000001","0000000002"]'::jsonb,
	"seats_available" integer DEFAULT 0 NOT NULL,
	"total_seats" integer DEFAULT 0 NOT NULL,
	"is_allocated_seating" boolean DEFAULT true,
	"allow_child_admits" boolean DEFAULT true,
	"allow_ticket_sales" boolean DEFAULT true,
	"soldout_status" integer DEFAULT 0,
	"price_group_code" text DEFAULT '',
	"sales_channels" text DEFAULT ';UNO;SAPP;POS;POSBK;IVR;KIOSK;WWW;PDA;CELL;CALL;RSP;GSALE;',
	"type_code" varchar(4) DEFAULT '01',
	"seat_layout_template_id" varchar(32),
	"booking_url" text DEFAULT '',
	"language" text DEFAULT '',
	"source_hash" text DEFAULT '',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_cinema_id_session_id_pk" PRIMARY KEY("cinema_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"vista_booking_id" varchar(16) PRIMARY KEY NOT NULL,
	"vista_booking_number" integer NOT NULL,
	"vista_trans_number" integer NOT NULL,
	"cinema_id" varchar(8) NOT NULL,
	"session_id" varchar(16) NOT NULL,
	"ho_code" varchar(12) NOT NULL,
	"film_title" text NOT NULL,
	"film_title_alt" text DEFAULT '',
	"film_classification" varchar(12) DEFAULT '',
	"experience" varchar(32) NOT NULL,
	"screen_name" text NOT NULL,
	"showtime" timestamp NOT NULL,
	"status" varchar(24) DEFAULT 'confirmed' NOT NULL,
	"customer_id" varchar(32),
	"customer" jsonb NOT NULL,
	"tickets" jsonb NOT NULL,
	"concessions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_offers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payments" jsonb NOT NULL,
	"total_value_cents" integer NOT NULL,
	"tax_value_cents" integer DEFAULT 0 NOT NULL,
	"booking_fee_value_cents" integer DEFAULT 0 NOT NULL,
	"refunded_value_cents" integer DEFAULT 0 NOT NULL,
	"sales_channel" varchar(8) DEFAULT 'WWW' NOT NULL,
	"source" varchar(16) DEFAULT 'seed' NOT NULL,
	"qr_payload" text DEFAULT '',
	"swapped_from_booking_id" varchar(16),
	"swapped_to_booking_id" varchar(16),
	"is_third_party" boolean DEFAULT false NOT NULL,
	"tickets_collected" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concession_items" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"cinema_id" varchar(8),
	"tab" text NOT NULL,
	"head_office_item_code" varchar(16) DEFAULT '',
	"hopk" varchar(8) DEFAULT '',
	"description" text NOT NULL,
	"description_alt" text DEFAULT '',
	"extended_description" text DEFAULT '',
	"extended_description_alt" text DEFAULT '',
	"price_in_cents" integer NOT NULL,
	"tax_in_cents" integer DEFAULT 0 NOT NULL,
	"item_class_code" varchar(8) DEFAULT 'BOX',
	"image_url" text DEFAULT '',
	"dietary_tags" jsonb DEFAULT '[]'::jsonb,
	"allergens" jsonb DEFAULT '[]'::jsonb,
	"calories" integer,
	"is_combo" boolean DEFAULT false,
	"package_child_items" jsonb DEFAULT '[]'::jsonb,
	"modifier_groups" jsonb DEFAULT '[]'::jsonb,
	"experiences" jsonb DEFAULT '[]'::jsonb,
	"in_seat_delivery" boolean DEFAULT false,
	"pickup_at_counter" boolean DEFAULT true,
	"is_best_seller" boolean DEFAULT false,
	"display_sequence" integer DEFAULT 100,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"user_session_id" varchar(64) PRIMARY KEY NOT NULL,
	"cinema_id" varchar(8) NOT NULL,
	"session_id" varchar(16),
	"state" varchar(24) DEFAULT 'draft' NOT NULL,
	"tickets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"concessions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_offers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_value_cents" integer DEFAULT 0 NOT NULL,
	"tax_value_cents" integer DEFAULT 0 NOT NULL,
	"booking_fee_value_cents" integer DEFAULT 0 NOT NULL,
	"discount_value_cents" integer DEFAULT 0 NOT NULL,
	"loyalty_points_payable_cents" integer DEFAULT 0 NOT NULL,
	"customer_id" varchar(32),
	"customer" jsonb,
	"conversation_id" varchar(64),
	"client_class" varchar(8) DEFAULT 'WWW',
	"seats_allocated" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expiry_at" timestamp with time zone NOT NULL,
	"completed_booking_id" varchar(16)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"booking_id" varchar(16) NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" varchar(24) NOT NULL,
	"tender_category" varchar(16) NOT NULL,
	"ticket_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text DEFAULT '',
	"reference" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'completed' NOT NULL,
	"initiated_by" varchar(32) DEFAULT 'concierge' NOT NULL,
	"conversation_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seat_layout_templates" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"experience" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"total_seats" integer NOT NULL,
	"layout" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_seat_state" (
	"cinema_id" varchar(8) NOT NULL,
	"session_id" varchar(16) NOT NULL,
	"seats" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_seat_state_cinema_id_session_id_pk" PRIMARY KEY("cinema_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_types" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"cinema_id" varchar(8) NOT NULL,
	"ticket_type_code" varchar(8) NOT NULL,
	"experience" varchar(32) NOT NULL,
	"area_category_code" varchar(10) NOT NULL,
	"description" text NOT NULL,
	"description_alt" text DEFAULT '',
	"long_description" text DEFAULT '',
	"price_in_cents" integer NOT NULL,
	"hopk" varchar(8) DEFAULT '',
	"head_office_grouping_code" varchar(12) DEFAULT '',
	"is_child_only" boolean DEFAULT false,
	"is_package" boolean DEFAULT false,
	"loyalty_only" boolean DEFAULT false,
	"loyalty_points_cost" integer,
	"qty_per_order" integer DEFAULT 10,
	"display_sequence" integer DEFAULT 1,
	"price_group_code" text DEFAULT '',
	"sales_channels" jsonb DEFAULT '["CALL","CELL","KIOSK","POS","POSBK","WWW"]'::jsonb
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"member_id" varchar(24),
	"preferred_language" varchar(4) DEFAULT 'en',
	"date_of_birth" text,
	"preferences" jsonb DEFAULT '{}'::jsonb,
	"home_cinema_id" varchar(8),
	"persona" text DEFAULT '',
	"demo_pin" varchar(8) DEFAULT '0000',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"member_id" varchar(24) PRIMARY KEY NOT NULL,
	"customer_id" varchar(32) NOT NULL,
	"tier" varchar(16) DEFAULT 'Blue' NOT NULL,
	"share_points_balance" integer DEFAULT 0 NOT NULL,
	"vox_rewards_balance_cents" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"member_id" varchar(24) NOT NULL,
	"balance_type" varchar(16) NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_redemptions" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"offer_id" varchar(32) NOT NULL,
	"member_id" varchar(24),
	"order_user_session_id" varchar(64),
	"booking_id" varchar(16),
	"discount_cents" integer NOT NULL,
	"status" varchar(16) DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"title_alt" text DEFAULT '',
	"short_description" text NOT NULL,
	"short_description_alt" text DEFAULT '',
	"terms" text DEFAULT '',
	"terms_alt" text DEFAULT '',
	"type" varchar(16) NOT NULL,
	"image_url" text DEFAULT '',
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"benefit" jsonb NOT NULL,
	"total_budget" integer,
	"remaining_budget" integer,
	"per_member_limit" integer,
	"how_to_redeem" text DEFAULT '',
	"active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_history" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"customer_id" varchar(32) NOT NULL,
	"booking_id" varchar(16),
	"cinema_id" varchar(8) NOT NULL,
	"ho_code" varchar(12),
	"film_title" text NOT NULL,
	"genres" jsonb DEFAULT '[]'::jsonb,
	"language" text DEFAULT '',
	"experience" varchar(32) NOT NULL,
	"showtime" timestamp NOT NULL,
	"ticket_count" integer DEFAULT 1 NOT NULL,
	"concession_item_ids" jsonb DEFAULT '[]'::jsonb,
	"spend_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"type" varchar(48) NOT NULL,
	"resource_key" varchar(96) NOT NULL,
	"input" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" varchar(16) DEFAULT 'agent' NOT NULL,
	"tool_call_id" varchar(64),
	"correlation_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"locked_by" varchar(64),
	"lease_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(64),
	"customer_id" varchar(32),
	"customer_name" text DEFAULT '',
	"customer_email" text DEFAULT '',
	"customer_phone" text DEFAULT '',
	"category" varchar(32) NOT NULL,
	"severity" varchar(8) DEFAULT 'medium' NOT NULL,
	"cinema_id" varchar(8),
	"booking_id" varchar(16),
	"visit_date" text,
	"description" text NOT NULL,
	"resolution_offered" text DEFAULT '',
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"sentiment" varchar(12) DEFAULT 'negative',
	"oneview_case_id" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"type" varchar(48) NOT NULL,
	"actor" varchar(16) DEFAULT 'system' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64),
	"channel" varchar(16) DEFAULT 'web' NOT NULL,
	"modality" varchar(8) DEFAULT 'text' NOT NULL,
	"language" varchar(4) DEFAULT 'en' NOT NULL,
	"customer_id" varchar(32),
	"member_id" varchar(24),
	"is_logged_in" boolean DEFAULT false NOT NULL,
	"market" varchar(4) DEFAULT 'AE' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"mode" varchar(8) DEFAULT 'bot' NOT NULL,
	"geo" jsonb,
	"outcome" varchar(24),
	"topics" jsonb DEFAULT '[]'::jsonb,
	"journeys" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"customer_id" varchar(32),
	"rating" integer NOT NULL,
	"comment" text DEFAULT '',
	"resolved" boolean,
	"language" varchar(4) DEFAULT 'en',
	"oneview_reference" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"language" varchar(4) DEFAULT 'en' NOT NULL,
	"category" varchar(32) NOT NULL,
	"source_url" text DEFAULT '',
	"content_markdown" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"elevenlabs_document_id" varchar(64),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics_daily" (
	"day" varchar(10) NOT NULL,
	"language" varchar(4) NOT NULL,
	"modality" varchar(8) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"conversations" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"transferred" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"journeys_completed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"journeys_abandoned" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transfer_reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"avg_duration_seconds" integer DEFAULT 0 NOT NULL,
	"avg_rating_x100" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_confirmations" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"action_type" varchar(48) NOT NULL,
	"resource_key" varchar(96) NOT NULL,
	"summary" jsonb NOT NULL,
	"spoken_summary" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"conversation_id" varchar(64) PRIMARY KEY NOT NULL,
	"turns" jsonb NOT NULL,
	"analysis" jsonb DEFAULT '{}'::jsonb,
	"summary" text DEFAULT '',
	"call_successful" varchar(12),
	"raw" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"reason" varchar(24) NOT NULL,
	"summary" text NOT NULL,
	"summary_alt" text DEFAULT '',
	"context" jsonb DEFAULT '{}'::jsonb,
	"adapter" varchar(16) NOT NULL,
	"external_conversation_id" varchar(64),
	"external_reference" text,
	"status" varchar(16) DEFAULT 'requested' NOT NULL,
	"agent_name" text,
	"oneview_note_id" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cinema_operators" ADD CONSTRAINT "cinema_operators_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_films" ADD CONSTRAINT "scheduled_films_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_films" ADD CONSTRAINT "scheduled_films_ho_code_films_ho_code_fk" FOREIGN KEY ("ho_code") REFERENCES "public"."films"("ho_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_ho_code_films_ho_code_fk" FOREIGN KEY ("ho_code") REFERENCES "public"."films"("ho_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_bookings_vista_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("vista_booking_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_member_id_loyalty_accounts_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."loyalty_accounts"("member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_redemptions" ADD CONSTRAINT "offer_redemptions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_history" ADD CONSTRAINT "purchase_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "films_status_idx" ON "films" USING btree ("status");--> statement-breakpoint
CREATE INDEX "films_title_idx" ON "films" USING btree ("title");--> statement-breakpoint
CREATE INDEX "sessions_film_idx" ON "sessions" USING btree ("ho_code");--> statement-breakpoint
CREATE INDEX "sessions_showtime_idx" ON "sessions" USING btree ("showtime");--> statement-breakpoint
CREATE INDEX "sessions_cinema_date_idx" ON "sessions" USING btree ("cinema_id","session_business_date");--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "bookings_email_idx" ON "bookings" USING btree ("customer");--> statement-breakpoint
CREATE INDEX "bookings_session_idx" ON "bookings" USING btree ("cinema_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_number_idx" ON "bookings" USING btree ("cinema_id","vista_booking_number");--> statement-breakpoint
CREATE INDEX "concession_tab_idx" ON "concession_items" USING btree ("tab");--> statement-breakpoint
CREATE INDEX "orders_state_expiry_idx" ON "orders" USING btree ("state","expiry_at");--> statement-breakpoint
CREATE INDEX "orders_conversation_idx" ON "orders" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "refunds_booking_idx" ON "refunds" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "ticket_types_cinema_exp_idx" ON "ticket_types" USING btree ("cinema_id","experience");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "customers_member_idx" ON "customers" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "loyalty_ledger_member_idx" ON "loyalty_ledger" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "offer_redemptions_member_idx" ON "offer_redemptions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "offers_type_idx" ON "offers" USING btree ("type");--> statement-breakpoint
CREATE INDEX "purchase_history_customer_idx" ON "purchase_history" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_idempotency_idx" ON "actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "actions_conversation_status_idx" ON "actions" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "actions_queue_idx" ON "actions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "actions_resource_idx" ON "actions" USING btree ("resource_key");--> statement-breakpoint
CREATE INDEX "complaints_status_idx" ON "complaints" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_events_seq_idx" ON "conversation_events" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "conversations_started_idx" ON "conversations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "conversations_customer_idx" ON "conversations" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_daily_key" ON "metrics_daily" USING btree ("day","language","modality","channel");--> statement-breakpoint
CREATE INDEX "pending_conf_conv_idx" ON "pending_confirmations" USING btree ("conversation_id","action_type");--> statement-breakpoint
CREATE INDEX "transfers_conversation_idx" ON "transfers" USING btree ("conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actions_one_running_per_conversation" ON "actions" ("conversation_id") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_customer_email_idx" ON "bookings" ((lower("customer"->>'Email')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_customer_phone_idx" ON "bookings" (("customer"->>'Phone'));
