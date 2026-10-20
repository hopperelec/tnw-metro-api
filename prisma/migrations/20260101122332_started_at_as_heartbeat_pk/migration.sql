-- NOTE: This migration assumes that the `startedAt` field in the `Heartbeat` table is unique,
--       but the database does not currently enforce this.

-- 1. ADD NEW COLUMNS (Initially nullable to allow data backfill)
ALTER TABLE `Train`
    ADD COLUMN `lastActiveHeartbeatAt` TIMESTAMP(3) NULL,
    ADD COLUMN `lastStatusChangeHeartbeatAt` TIMESTAMP(3) NULL,
    ADD COLUMN `wentInactiveHeartbeatAt` TIMESTAMP(3) NULL;

ALTER TABLE `TimesApiTrainData`
    ADD COLUMN `startHeartbeatAt` TIMESTAMP(3) NULL,
    ADD COLUMN `endHeartbeatAt` TIMESTAMP(3) NULL;

ALTER TABLE `GeoApiTrainData`
    ADD COLUMN `startHeartbeatAt` TIMESTAMP(3) NULL,
    ADD COLUMN `endHeartbeatAt` TIMESTAMP(3) NULL;

ALTER TABLE `HeartbeatError`
    ADD COLUMN `heartbeatAt` TIMESTAMP(3) NULL;

ALTER TABLE `HeartbeatWarning`
    ADD COLUMN `heartbeatAt` TIMESTAMP(3) NULL;

-- 2. BACKFILL DATA (Map IDs to Timestamps)
-- Train
UPDATE `Train` t JOIN `Heartbeat` h ON t.lastActiveHeartbeatId = h.id
SET t.lastActiveHeartbeatAt = h.startedAt;

UPDATE `Train` t JOIN `Heartbeat` h ON t.lastStatusChangeHeartbeatId = h.id
SET t.lastStatusChangeHeartbeatAt = h.startedAt;

UPDATE `Train` t JOIN `Heartbeat` h ON t.wentInactiveHeartbeatId = h.id
SET t.wentInactiveHeartbeatAt = h.startedAt;

-- TimesApiTrainData
UPDATE `TimesApiTrainData` t JOIN `Heartbeat` h ON t.startHeartbeatId = h.id
SET t.startHeartbeatAt = h.startedAt;

UPDATE `TimesApiTrainData` t JOIN `Heartbeat` h ON t.endHeartbeatId = h.id
SET t.endHeartbeatAt = h.startedAt;

-- GeoApiTrainData
UPDATE `GeoApiTrainData` t JOIN `Heartbeat` h ON t.startHeartbeatId = h.id
SET t.startHeartbeatAt = h.startedAt;

UPDATE `GeoApiTrainData` t JOIN `Heartbeat` h ON t.endHeartbeatId = h.id
SET t.endHeartbeatAt = h.startedAt;

-- Diagnostics
UPDATE `HeartbeatError` e JOIN `Heartbeat` h ON e.heartbeatId = h.id
SET e.heartbeatAt = h.startedAt;

UPDATE `HeartbeatWarning` w JOIN `Heartbeat` h ON w.heartbeatId = h.id
SET w.heartbeatAt = h.startedAt;

-- 3. DROP OLD FOREIGN KEYS
ALTER TABLE `Train`
    DROP FOREIGN KEY `Train_lastActiveHeartbeatId_fkey`,
    DROP FOREIGN KEY `Train_lastStatusChangeHeartbeatId_fkey`,
    DROP FOREIGN KEY `Train_wentInactiveHeartbeatId_fkey`;

ALTER TABLE `TimesApiTrainData`
    DROP FOREIGN KEY `TimesApiTrainData_startHeartbeatId_fkey`,
    DROP FOREIGN KEY `TimesApiTrainData_endHeartbeatId_fkey`;

ALTER TABLE `GeoApiTrainData`
    DROP FOREIGN KEY `GeoApiTrainData_startHeartbeatId_fkey`,
    DROP FOREIGN KEY `GeoApiTrainData_endHeartbeatId_fkey`;

ALTER TABLE `HeartbeatError` DROP FOREIGN KEY `HeartbeatError_heartbeatId_fkey`;
ALTER TABLE `HeartbeatWarning` DROP FOREIGN KEY `HeartbeatWarning_heartbeatId_fkey`;

-- 4. UPDATE HEARTBEAT PRIMARY KEY
-- First remove AUTO_INCREMENT from id so we can drop the PK
ALTER TABLE `Heartbeat` MODIFY `id` INT NOT NULL;
ALTER TABLE `Heartbeat`
    DROP PRIMARY KEY,
    DROP COLUMN `id`,
    -- Set new PK
    ADD PRIMARY KEY (`startedAt`);

-- 5. CLEANUP AND ADD NEW CONSTRAINTS
-- Train
ALTER TABLE `Train`
    DROP COLUMN `lastActiveHeartbeatId`,
    DROP COLUMN `lastStatusChangeHeartbeatId`,
    DROP COLUMN `wentInactiveHeartbeatId`,

    MODIFY `lastActiveHeartbeatAt` TIMESTAMP(3) NOT NULL,
    MODIFY `lastStatusChangeHeartbeatAt` TIMESTAMP(3) NOT NULL,

    ADD CONSTRAINT `Train_lastActiveHeartbeatAt_fkey` FOREIGN KEY (`lastActiveHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `Train_lastStatusChangeHeartbeatAt_fkey` FOREIGN KEY (`lastStatusChangeHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `Train_wentInactiveHeartbeatAt_fkey` FOREIGN KEY (`wentInactiveHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;

-- TimesApiTrainData
ALTER TABLE `TimesApiTrainData`
    DROP COLUMN `startHeartbeatId`,
    DROP COLUMN `endHeartbeatId`,

    MODIFY `startHeartbeatAt` TIMESTAMP(3) NOT NULL,

    ADD CONSTRAINT `TimesApiTrainData_startHeartbeatAt_fkey` FOREIGN KEY (`startHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `TimesApiTrainData_endHeartbeatAt_fkey` FOREIGN KEY (`endHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;

-- GeoApiTrainData
ALTER TABLE `GeoApiTrainData`
    DROP COLUMN `startHeartbeatId`,
    DROP COLUMN `endHeartbeatId`,

    MODIFY `startHeartbeatAt` TIMESTAMP(3) NOT NULL,

    ADD CONSTRAINT `GeoApiTrainData_startHeartbeatAt_fkey` FOREIGN KEY (`startHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `GeoApiTrainData_endHeartbeatAt_fkey` FOREIGN KEY (`endHeartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Diagnostics
ALTER TABLE `HeartbeatError`
    DROP COLUMN `heartbeatId`,
    MODIFY `heartbeatAt` TIMESTAMP(3) NOT NULL,
    ADD CONSTRAINT `HeartbeatError_heartbeatAt_fkey` FOREIGN KEY (`heartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `HeartbeatWarning`
    DROP COLUMN `heartbeatId`,
    MODIFY `heartbeatAt` TIMESTAMP(3) NOT NULL,
    ADD CONSTRAINT `HeartbeatWarning_heartbeatAt_fkey` FOREIGN KEY (`heartbeatAt`) REFERENCES `Heartbeat`(`startedAt`) ON DELETE CASCADE ON UPDATE CASCADE;