-- ===== 0027_giant_shinko_yamashiro =====
CREATE INDEX `phase_updated_at_video_id_idx` ON `video_uploads` (`phase`,`updated_at`,`video_id`);
-- ===== 0028_nebulous_madame_masque =====
ALTER TABLE `folders` ADD `public` boolean DEFAULT false NOT NULL;
ALTER TABLE `spaces` ADD `public` boolean DEFAULT false NOT NULL;
CREATE INDEX `public_parent_id_idx` ON `folders` (`public`,`parentId`);
CREATE INDEX `public_idx` ON `spaces` (`public`);
-- ===== 0029_blushing_pretty_boy =====
DROP INDEX `public_idx` ON `spaces`;
CREATE INDEX `public_space_parent_id_idx` ON `folders` (`public`,`spaceId`,`parentId`);
CREATE INDEX `public_organization_id_idx` ON `spaces` (`public`,`organizationId`);
-- ===== 0030_add_folder_settings =====
ALTER TABLE `folders` ADD `settings` json;
-- ===== 0031_add_auth_api_keys_user_created_index =====
CREATE INDEX `user_id_created_at_idx` ON `auth_api_keys` (`userId`,`createdAt`);
-- ===== 0032_past_lester =====
CREATE TABLE `messenger_support_emails` (
	`id` varchar(15) NOT NULL,
	`conversationId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`userEmail` varchar(255) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messenger_support_emails_id` PRIMARY KEY(`id`)
);

ALTER TABLE `messenger_support_emails` ADD CONSTRAINT `support_email_conversation_fk` FOREIGN KEY (`conversationId`) REFERENCES `messenger_conversations`(`id`) ON DELETE cascade ON UPDATE no action;
CREATE INDEX `support_email_user_created_at_idx` ON `messenger_support_emails` (`userId`,`createdAt`);
CREATE INDEX `support_email_conversation_created_at_idx` ON `messenger_support_emails` (`conversationId`,`createdAt`);
-- ===== 0033_fluffy_gamora =====
ALTER TABLE `auth_api_keys` ADD `source` varchar(32);
-- ===== 0034_fluffy_falcon =====
UPDATE `auth_api_keys` SET `source` = 'unknown' WHERE `source` IS NULL;
ALTER TABLE `auth_api_keys` MODIFY COLUMN `source` varchar(32) NOT NULL DEFAULT 'unknown';

-- ===== 0035_agent_api =====
CREATE TABLE `agent_api_authorization_codes` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`codeHash` varchar(64) NOT NULL,
	`codeChallenge` varchar(64) NOT NULL,
	`redirectUri` varchar(512) NOT NULL,
	`scopes` json NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_api_authorization_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `code_hash_idx` UNIQUE(`codeHash`)
);

CREATE TABLE `agent_api_idempotency` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`operation` varchar(64) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`state` varchar(16) NOT NULL DEFAULT 'pending',
	`statusCode` int,
	`response` json,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_api_idempotency_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_operation_key_idx` UNIQUE(`userId`,`operation`,`keyHash`)
);

CREATE TABLE `agent_api_keys` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL DEFAULT 'Cap CLI',
	`scopes` json NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp,
	CONSTRAINT `agent_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `token_hash_idx` UNIQUE(`tokenHash`)
);

CREATE INDEX `expires_at_idx` ON `agent_api_authorization_codes` (`expiresAt`);
CREATE INDEX `user_created_at_idx` ON `agent_api_authorization_codes` (`userId`,`createdAt`);
CREATE INDEX `expires_at_idx` ON `agent_api_idempotency` (`expiresAt`);
CREATE INDEX `user_created_at_idx` ON `agent_api_keys` (`userId`,`createdAt`);
CREATE INDEX `expires_at_idx` ON `agent_api_keys` (`expiresAt`);
-- ===== 0036_premium_master_chief =====
CREATE TABLE `agent_api_operations` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`resourceId` varchar(15) NOT NULL,
	`resultResourceId` varchar(15),
	`state` varchar(16) NOT NULL DEFAULT 'queued',
	`payload` json NOT NULL,
	`result` json,
	`errorCode` varchar(64),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `agent_api_operations_id` PRIMARY KEY(`id`)
);

CREATE INDEX `user_created_at_idx` ON `agent_api_operations` (`userId`,`createdAt`);
CREATE INDEX `state_updated_at_idx` ON `agent_api_operations` (`state`,`updatedAt`);
CREATE INDEX `resource_id_idx` ON `agent_api_operations` (`resourceId`);
