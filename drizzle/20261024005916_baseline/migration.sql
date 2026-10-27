-- Baseline matching the schema created by Prisma's migrations, for creating new databases. Existing databases already
-- have this schema, so are only marked as having run it (see `src/db/migrate.ts`).
-- The table options are added manually, since drizzle-kit doesn't manage them, but Prisma created every table with them.
CREATE TABLE `Destination` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL,
	CONSTRAINT `Destination_name_key` UNIQUE INDEX(`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `GeoApiTrainData` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`trainId` smallint unsigned NOT NULL,
	`destinationId` int NOT NULL,
	`rawLastSeen` varchar(191),
	`lastEventPlatformId` int,
	`lastEventTypeId` tinyint unsigned,
	`lastEventTime` timestamp(3),
	`startHeartbeatAt` timestamp(3) NOT NULL,
	`endHeartbeatAt` timestamp(3),
	CONSTRAINT `GeoApiTrainData_trainId_startHeartbeatAt_key` UNIQUE INDEX(`trainId`,`startHeartbeatAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `Heartbeat` (
	`startedAt` timestamp(3) PRIMARY KEY,
	`endedAt` timestamp(3)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `HeartbeatError` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`api` enum('TIMES','GEO','GATEWAY') NOT NULL,
	`message` text NOT NULL,
	`heartbeatAt` timestamp(3) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `HeartbeatWarning` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`api` enum('TIMES','GEO','GATEWAY') NOT NULL,
	`data` json NOT NULL,
	`heartbeatAt` timestamp(3) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `ParsedPlatform` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`station` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL,
	`platformNumber` tinyint unsigned NOT NULL,
	CONSTRAINT `ParsedPlatform_station_platformNumber_key` UNIQUE INDEX(`station`,`platformNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `PlannedDestination` (
	`statusId` int NOT NULL,
	`destinationId` int NOT NULL,
	`fromTime` timestamp(3) NOT NULL,
	`fromPlatformId` int NOT NULL,
	CONSTRAINT PRIMARY KEY(`statusId`,`destinationId`,`fromTime`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `TimesApiTrainData` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`trainId` smallint unsigned NOT NULL,
	`lastEventTypeId` tinyint unsigned NOT NULL,
	`lastEventTime` timestamp(3) NOT NULL,
	`lastEventLocationId` int NOT NULL,
	`startHeartbeatAt` timestamp(3) NOT NULL,
	`endHeartbeatAt` timestamp(3),
	`firstPlannedDestinationId` int,
	CONSTRAINT `TimesApiTrainData_trainId_startHeartbeatAt_key` UNIQUE INDEX(`trainId`,`startHeartbeatAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `Train` (
	`id` smallint unsigned AUTO_INCREMENT PRIMARY KEY,
	`trn` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL,
	CONSTRAINT `Train_trn_key` UNIQUE INDEX(`trn`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `TrainEventType` (
	`id` tinyint unsigned AUTO_INCREMENT PRIMARY KEY,
	`name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL,
	CONSTRAINT `TrainEventType_name_key` UNIQUE INDEX(`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE `UnparsedPlatform` (
	`id` int AUTO_INCREMENT PRIMARY KEY,
	`raw` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL,
	`parsedPlatformId` int,
	CONSTRAINT `UnparsedPlatform_raw_key` UNIQUE INDEX(`raw`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE INDEX `GeoApiTrainData_destinationId_fkey` ON `GeoApiTrainData` (`destinationId`);--> statement-breakpoint
CREATE INDEX `GeoApiTrainData_lastEventTypeId_fkey` ON `GeoApiTrainData` (`lastEventTypeId`);--> statement-breakpoint
CREATE INDEX `GeoApiTrainData_lastEventPlatformId_fkey` ON `GeoApiTrainData` (`lastEventPlatformId`);--> statement-breakpoint
CREATE INDEX `GeoApiTrainData_startHeartbeatAt_fkey` ON `GeoApiTrainData` (`startHeartbeatAt`);--> statement-breakpoint
CREATE INDEX `GeoApiTrainData_endHeartbeatAt_fkey` ON `GeoApiTrainData` (`endHeartbeatAt`);--> statement-breakpoint
CREATE INDEX `HeartbeatError_heartbeatAt_fkey` ON `HeartbeatError` (`heartbeatAt`);--> statement-breakpoint
CREATE INDEX `HeartbeatWarning_heartbeatAt_fkey` ON `HeartbeatWarning` (`heartbeatAt`);--> statement-breakpoint
CREATE INDEX `PlannedDestination_destinationId_fkey` ON `PlannedDestination` (`destinationId`);--> statement-breakpoint
CREATE INDEX `PlannedDestination_fromPlatformId_fkey` ON `PlannedDestination` (`fromPlatformId`);--> statement-breakpoint
CREATE INDEX `TimesApiTrainData_lastEventLocationId_fkey` ON `TimesApiTrainData` (`lastEventLocationId`);--> statement-breakpoint
CREATE INDEX `TimesApiTrainData_lastEventTypeId_fkey` ON `TimesApiTrainData` (`lastEventTypeId`);--> statement-breakpoint
CREATE INDEX `TimesApiTrainData_startHeartbeatAt_fkey` ON `TimesApiTrainData` (`startHeartbeatAt`);--> statement-breakpoint
CREATE INDEX `TimesApiTrainData_endHeartbeatAt_fkey` ON `TimesApiTrainData` (`endHeartbeatAt`);--> statement-breakpoint
CREATE INDEX `TimesApiTrainData_firstPlannedDestinationId_fkey` ON `TimesApiTrainData` (`firstPlannedDestinationId`);--> statement-breakpoint
CREATE INDEX `UnparsedPlatform_parsedPlatformId_fkey` ON `UnparsedPlatform` (`parsedPlatformId`);--> statement-breakpoint
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_trainId_fkey` FOREIGN KEY (`trainId`) REFERENCES `Train`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_startHeartbeatAt_fkey` FOREIGN KEY (`startHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_endHeartbeatAt_fkey` FOREIGN KEY (`endHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_destinationId_fkey` FOREIGN KEY (`destinationId`) REFERENCES `Destination`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_lastEventPlatformId_fkey` FOREIGN KEY (`lastEventPlatformId`) REFERENCES `ParsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_lastEventTypeId_fkey` FOREIGN KEY (`lastEventTypeId`) REFERENCES `TrainEventType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `HeartbeatError` ADD CONSTRAINT `HeartbeatError_heartbeatAt_fkey` FOREIGN KEY (`heartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `HeartbeatWarning` ADD CONSTRAINT `HeartbeatWarning_heartbeatAt_fkey` FOREIGN KEY (`heartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `PlannedDestination` ADD CONSTRAINT `PlannedDestination_statusId_fkey` FOREIGN KEY (`statusId`) REFERENCES `TimesApiTrainData`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `PlannedDestination` ADD CONSTRAINT `PlannedDestination_destinationId_fkey` FOREIGN KEY (`destinationId`) REFERENCES `Destination`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `PlannedDestination` ADD CONSTRAINT `PlannedDestination_fromPlatformId_fkey` FOREIGN KEY (`fromPlatformId`) REFERENCES `UnparsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_trainId_fkey` FOREIGN KEY (`trainId`) REFERENCES `Train`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_startHeartbeatAt_fkey` FOREIGN KEY (`startHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_endHeartbeatAt_fkey` FOREIGN KEY (`endHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_lastEventLocationId_fkey` FOREIGN KEY (`lastEventLocationId`) REFERENCES `UnparsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_lastEventTypeId_fkey` FOREIGN KEY (`lastEventTypeId`) REFERENCES `TrainEventType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_firstPlannedDestinationId_fkey` FOREIGN KEY (`firstPlannedDestinationId`) REFERENCES `Destination`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE `UnparsedPlatform` ADD CONSTRAINT `UnparsedPlatform_parsedPlatformId_fkey` FOREIGN KEY (`parsedPlatformId`) REFERENCES `ParsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;