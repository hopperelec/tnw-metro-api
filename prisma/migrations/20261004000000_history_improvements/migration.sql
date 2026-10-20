-- Data hashes are no longer used, since new data is compared directly with the data which is current for each train.
-- Instead, a train can only have one data entry per API starting at a given heartbeat.

-- DropIndex
DROP INDEX `GeoApiTrainData_hash_key` ON `GeoApiTrainData`;

-- DropIndex
DROP INDEX `TimesApiTrainData_hash_key` ON `TimesApiTrainData`;

-- AlterTable
ALTER TABLE `GeoApiTrainData` DROP COLUMN `hash`;

-- AlterTable
ALTER TABLE `TimesApiTrainData` DROP COLUMN `hash`;

-- CreateIndex
CREATE UNIQUE INDEX `GeoApiTrainData_trainId_startHeartbeatAt_key` ON `GeoApiTrainData`(`trainId`, `startHeartbeatAt`);

-- CreateIndex
CREATE UNIQUE INDEX `TimesApiTrainData_trainId_startHeartbeatAt_key` ON `TimesApiTrainData`(`trainId`, `startHeartbeatAt`);

-- When a train last changed status is now found from its data, rather than being stored separately (which wasn't kept
--  up to date).

-- DropForeignKey
ALTER TABLE `Train` DROP FOREIGN KEY `Train_lastActiveHeartbeatAt_fkey`;

-- DropForeignKey
ALTER TABLE `Train` DROP FOREIGN KEY `Train_lastStatusChangeHeartbeatAt_fkey`;

-- DropForeignKey
ALTER TABLE `Train` DROP FOREIGN KEY `Train_wentInactiveHeartbeatAt_fkey`;

-- DropIndex
DROP INDEX `Train_lastActiveHeartbeatAt_fkey` ON `Train`;

-- DropIndex
DROP INDEX `Train_lastStatusChangeHeartbeatAt_fkey` ON `Train`;

-- DropIndex
DROP INDEX `Train_wentInactiveHeartbeatAt_fkey` ON `Train`;

-- AlterTable
ALTER TABLE `Train` DROP COLUMN `lastActiveHeartbeatAt`,
    DROP COLUMN `lastStatusChangeHeartbeatAt`,
    DROP COLUMN `wentInactiveHeartbeatAt`;

-- Filtering Times API data by its first planned destination previously required a correlated subquery per row,
--  which could take minutes for rarely-used destinations. It is now stored directly so that it can be indexed.

-- AlterTable
ALTER TABLE `TimesApiTrainData` ADD COLUMN `firstPlannedDestinationId` INTEGER NULL;

-- Backfill existing data (before adding the foreign key, whose index is faster to create than to update for every row).
-- Planned destinations with the same time are ordered by platform code, the same as when parsed.
UPDATE `TimesApiTrainData` data
SET data.`firstPlannedDestinationId` = (
    SELECT pd.`destinationId`
    FROM `PlannedDestination` pd
    JOIN `UnparsedPlatform` p ON p.`id` = pd.`fromPlatformId`
    WHERE pd.`statusId` = data.`id`
    ORDER BY pd.`fromTime` ASC, p.`raw` COLLATE utf8mb4_bin ASC
    LIMIT 1
);

-- AddForeignKey
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_firstPlannedDestinationId_fkey` FOREIGN KEY (`firstPlannedDestinationId`) REFERENCES `Destination`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Lookup values are raw strings from the APIs, and are cached and matched exactly by the history code.
-- With a case-insensitive collation, a change in capitalisation from an API (e.g. "Not in service" -> "Not In Service")
--  would violate these unique constraints and cause the whole heartbeat's data to fail to be saved.
-- A `_bin` collation can't be used, since the Prisma MariaDB adapter returns binary-collated columns from raw queries
--  as bytes rather than strings.

ALTER TABLE `Destination` MODIFY `name` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL;
ALTER TABLE `ParsedPlatform` MODIFY `station` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL;
ALTER TABLE `Train` MODIFY `trn` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL;
ALTER TABLE `TrainEventType` MODIFY `name` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL;
ALTER TABLE `UnparsedPlatform` MODIFY `raw` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_nopad_as_cs NOT NULL;
