CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "appointments_user_id_created_at_idx" ON "appointments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "appointments_booking_id_idx" ON "appointments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "hunger_checkins_user_id_created_at_idx" ON "hunger_checkins" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "meal_logs_user_id_logged_at_idx" ON "meal_logs" USING btree ("user_id","logged_at");--> statement-breakpoint
CREATE INDEX "messages_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "message_threads_user_id_idx" ON "message_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");