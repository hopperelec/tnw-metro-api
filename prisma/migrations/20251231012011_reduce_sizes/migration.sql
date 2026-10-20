SET FOREIGN_KEY_CHECKS=0;
SET @old_time_zone = @@session.time_zone;
SET time_zone = '+00:00';
SET @ZERO_TIMESTAMP = '1970-01-01 00:00:00';

-- Fail early if there are any unwanted occurrences of the zero timestamp.
-- This checks for '1970-01-01 00:00:00' in any datetime column,
-- EXCLUDING those heartbeats where *both* startedAt and endedAt are the zero timestamp.
SELECT
    (
        -- Check Heartbeat: startedAt is zero, BUT endedAt is NULL or NOT zero
        SELECT EXISTS(
            SELECT 1 FROM `Heartbeat`
            WHERE `startedAt` = @ZERO_TIMESTAMP
              AND (`endedAt` IS NULL OR `endedAt` != @ZERO_TIMESTAMP)
            LIMIT 1
        )
    ) OR (
        -- Check Heartbeat: endedAt is zero, BUT startedAt is NOT zero
        SELECT EXISTS(
            SELECT 1 FROM `Heartbeat`
            WHERE `endedAt` = @ZERO_TIMESTAMP
              AND `startedAt` != @ZERO_TIMESTAMP
            LIMIT 1
        )
    ) OR (
        -- Check TimesApiTrainData.lastEventTime
        SELECT EXISTS(
            SELECT 1 FROM `TimesApiTrainData` WHERE `lastEventTime` = @ZERO_TIMESTAMP LIMIT 1
        )
    ) OR (
        -- Check PlannedDestination.fromTime
        SELECT EXISTS(
            SELECT 1 FROM `PlannedDestination` WHERE `fromTime` = @ZERO_TIMESTAMP LIMIT 1
        )
    ) OR (
        -- Check GeoApiTrainData.lastEventTime
        SELECT EXISTS(
            SELECT 1 FROM `GeoApiTrainData` WHERE `lastEventTime` = @ZERO_TIMESTAMP LIMIT 1
        )
    )
INTO @unwanted_zero_timestamp_found;

IF @unwanted_zero_timestamp_found THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration aborted: Unwanted 1970-01-01 00:00:00 timestamp found in the database. Please review and resolve manually before re-running this migration.';
END IF;

-- Update Heartbeat entries where both startedAt and endedAt are the zero timestamp
-- to use '1970-01-01 00:00:01' instead
UPDATE `Heartbeat`
SET
    `startedAt` = '1970-01-01 00:00:01',
    `endedAt` = '1970-01-01 00:00:01'
WHERE
    `startedAt` = @ZERO_TIMESTAMP AND `endedAt` = @ZERO_TIMESTAMP;

-- Rename Platform to ParsedPlatform
RENAME TABLE `Platform` TO `ParsedPlatform`;

-- Create the new UnparsedPlatform table
CREATE TABLE `UnparsedPlatform` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `raw` VARCHAR(191) NOT NULL,
    `parsedPlatformId` INTEGER NULL,

    UNIQUE INDEX `UnparsedPlatform_raw_key`(`raw`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Consolidate all platform strings into UnparsedPlatform in one query
INSERT IGNORE INTO `UnparsedPlatform` (`raw`, `parsedPlatformId`)
SELECT `raw`, `parsedPlatformId` FROM (
    -- Get raw strings from PlannedDestination
    SELECT `fromPlatform` AS `raw`, NULL AS `parsedPlatformId` FROM `PlannedDestination`
    -- Get raw strings from TimesApiTrainData
    UNION
    SELECT `rawLastEventLocation` AS `raw`, NULL AS `parsedPlatformId` FROM `TimesApiTrainData` WHERE `rawLastEventLocation` IS NOT NULL
    -- Get reconstructed raw strings from ParsedPlatform for used locations
    UNION
    SELECT DISTINCT CONCAT(`station`, ' Platform ', `platformNumber`) AS `raw`, pp.`id` AS `parsedPlatformId`
    FROM `ParsedPlatform` pp
        INNER JOIN `TimesApiTrainData` tatd ON pp.id = tatd.parsedLastEventLocationId
) AS all_platforms;

-- Migrate PlannedDestination
ALTER TABLE `PlannedDestination` ADD COLUMN `fromPlatformId` INTEGER;
UPDATE `PlannedDestination` pd JOIN `UnparsedPlatform` up ON pd.`fromPlatform` = up.`raw` SET pd.`fromPlatformId` = up.`id`;

-- Migrate TimesApiTrainData
ALTER TABLE `TimesApiTrainData` ADD COLUMN `lastEventLocationId` INTEGER;
UPDATE `TimesApiTrainData` t JOIN `UnparsedPlatform` up ON t.`rawLastEventLocation` = up.`raw` SET t.`lastEventLocationId` = up.`id`;
UPDATE `TimesApiTrainData` t JOIN `UnparsedPlatform` up ON t.`parsedLastEventLocationId` = up.`parsedPlatformId` SET t.`lastEventLocationId` = up.`id` WHERE t.`parsedLastEventLocationId` IS NOT NULL;

-- Drop foreign keys that will be modified or point to columns being dropped
ALTER TABLE `TimesApiTrainData`
    DROP FOREIGN KEY `TimesApiTrainData_lastEventTypeId_fkey`,
    DROP FOREIGN KEY `TimesApiTrainData_trainId_fkey`,
    DROP FOREIGN KEY `TimesApiTrainData_parsedLastEventLocationId_fkey`;
ALTER TABLE `GeoApiTrainData`
    DROP FOREIGN KEY `GeoApiTrainData_lastEventTypeId_fkey`,
    DROP FOREIGN KEY `GeoApiTrainData_trainId_fkey`,
    DROP FOREIGN KEY `GeoApiTrainData_lastEventPlatformId_fkey`;
DROP INDEX `Platform_station_platformNumber_key` ON `ParsedPlatform`;

-- TimesApiTrainData: Convert hash, drop old columns, modify types
ALTER TABLE `TimesApiTrainData`
    ADD COLUMN `hash_bin` BINARY(20);
UPDATE `TimesApiTrainData` SET `hash_bin` = FROM_BASE64(`hash`);
ALTER TABLE `TimesApiTrainData`
    DROP COLUMN `hash`,
    CHANGE `hash_bin` `hash` BINARY(20) NOT NULL,
    DROP COLUMN `parsedLastEventLocationId`,
    DROP COLUMN `rawLastEventLocation`,
    MODIFY `lastEventLocationId` INTEGER NOT NULL,
    MODIFY `trainId` SMALLINT UNSIGNED NOT NULL,
    MODIFY `lastEventTypeId` TINYINT UNSIGNED NOT NULL,
    MODIFY `lastEventTime` TIMESTAMP(3) NOT NULL,
    ADD UNIQUE INDEX `TimesApiTrainData_hash_key`(`hash`);

-- GeoApiTrainData: Convert hash, modify types
ALTER TABLE `GeoApiTrainData`
    ADD COLUMN `hash_bin` BINARY(20);
UPDATE `GeoApiTrainData` SET `hash_bin` = FROM_BASE64(`hash`);
ALTER TABLE `GeoApiTrainData`
    DROP COLUMN `hash`,
    CHANGE `hash_bin` `hash` BINARY(20) NOT NULL,
    MODIFY `trainId` SMALLINT UNSIGNED NOT NULL,
    MODIFY `lastEventTypeId` TINYINT UNSIGNED NULL,
    MODIFY `lastEventTime` TIMESTAMP(3) NULL,
    ADD UNIQUE INDEX `GeoApiTrainData_hash_key`(`hash`);

-- PlannedDestination: Drop old columns, modify types, make the unique index the new primary key
ALTER TABLE `PlannedDestination` MODIFY `id` INTEGER NOT NULL;
ALTER TABLE `PlannedDestination`
    DROP PRIMARY KEY,
    DROP COLUMN `id`,
    DROP COLUMN `fromPlatform`,
    MODIFY `fromPlatformId` INTEGER NOT NULL,
    MODIFY `fromTime` TIMESTAMP(3) NOT NULL,
    ADD PRIMARY KEY (`statusId`, `destinationId`, `fromTime`);
DROP INDEX `PlannedDestination_statusId_destinationId_fromTime_key` ON `PlannedDestination`;

-- Other table modifications
ALTER TABLE `Train` MODIFY `id` SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `TrainEventType` MODIFY `id` TINYINT UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `ParsedPlatform` MODIFY `platformNumber` TINYINT UNSIGNED NOT NULL;
ALTER TABLE `Heartbeat` MODIFY `startedAt` TIMESTAMP(3) NOT NULL, MODIFY `endedAt` TIMESTAMP(3) NULL;
ALTER TABLE `HeartbeatError` MODIFY `message` TEXT NOT NULL;

-- Recreate indexes and foreign keys
CREATE UNIQUE INDEX `ParsedPlatform_station_platformNumber_key` ON `ParsedPlatform`(`station`, `platformNumber`);

ALTER TABLE `UnparsedPlatform` ADD CONSTRAINT `UnparsedPlatform_parsedPlatformId_fkey` FOREIGN KEY (`parsedPlatformId`) REFERENCES `ParsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TimesApiTrainData`
    ADD CONSTRAINT `TimesApiTrainData_trainId_fkey` FOREIGN KEY (`trainId`) REFERENCES `Train`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `TimesApiTrainData_lastEventLocationId_fkey` FOREIGN KEY (`lastEventLocationId`) REFERENCES `UnparsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `TimesApiTrainData_lastEventTypeId_fkey` FOREIGN KEY (`lastEventTypeId`) REFERENCES `TrainEventType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `PlannedDestination` ADD CONSTRAINT `PlannedDestination_fromPlatformId_fkey` FOREIGN KEY (`fromPlatformId`) REFERENCES `UnparsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `GeoApiTrainData`
    ADD CONSTRAINT `GeoApiTrainData_trainId_fkey` FOREIGN KEY (`trainId`) REFERENCES `Train`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `GeoApiTrainData_lastEventTypeId_fkey` FOREIGN KEY (`lastEventTypeId`) REFERENCES `TrainEventType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `GeoApiTrainData_lastEventPlatformId_fkey` FOREIGN KEY (`lastEventPlatformId`) REFERENCES `ParsedPlatform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

SET FOREIGN_KEY_CHECKS=1;
SET time_zone = @old_time_zone;