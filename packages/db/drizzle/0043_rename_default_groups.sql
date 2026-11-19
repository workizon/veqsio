-- The default groups were named after Jira. Rename them (only when the new name is free, so a manual rename is never overwritten).
UPDATE "groups" SET "name" = 'veqsio-administrators' WHERE "name" = 'jira-administrators' AND NOT EXISTS (SELECT 1 FROM "groups" WHERE "name" = 'veqsio-administrators');--> statement-breakpoint
UPDATE "groups" SET "name" = 'veqsio-developers' WHERE "name" = 'jira-developers' AND NOT EXISTS (SELECT 1 FROM "groups" WHERE "name" = 'veqsio-developers');--> statement-breakpoint
UPDATE "groups" SET "name" = 'veqsio-users' WHERE "name" = 'jira-users' AND NOT EXISTS (SELECT 1 FROM "groups" WHERE "name" = 'veqsio-users');
