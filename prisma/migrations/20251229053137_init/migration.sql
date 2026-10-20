-- CreateTable
CREATE TABLE `Heartbeat` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainEventType` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `TrainEventType_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Train` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trn` VARCHAR(191) NOT NULL,
    `lastActiveHeartbeatId` INTEGER NOT NULL,
    `lastStatusChangeHeartbeatId` INTEGER NOT NULL,
    `wentInactiveHeartbeatId` INTEGER NULL,

    UNIQUE INDEX `Train_trn_key`(`trn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Platform` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `station` VARCHAR(191) NOT NULL,
    `platformNumber` INTEGER NOT NULL,

    UNIQUE INDEX `Platform_station_platformNumber_key`(`station`, `platformNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Destination` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Destination_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TimesApiTrainData` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `hash` VARCHAR(191) NOT NULL,
    `trainId` INTEGER NOT NULL,
    `startHeartbeatId` INTEGER NOT NULL,
    `endHeartbeatId` INTEGER NULL,
    `parsedLastEventLocationId` INTEGER NULL,
    `rawLastEventLocation` VARCHAR(191) NULL,
    `lastEventTypeId` INTEGER NOT NULL,
    `lastEventTime` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TimesApiTrainData_hash_key`(`hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlannedDestination` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `statusId` INTEGER NOT NULL,
    `destinationId` INTEGER NOT NULL,
    `fromTime` DATETIME(3) NOT NULL,
    `fromPlatform` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `PlannedDestination_statusId_destinationId_fromTime_key`(`statusId`, `destinationId`, `fromTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeoApiTrainData` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `hash` VARCHAR(191) NOT NULL,
    `trainId` INTEGER NOT NULL,
    `startHeartbeatId` INTEGER NOT NULL,
    `endHeartbeatId` INTEGER NULL,
    `destinationId` INTEGER NOT NULL,
    `rawLastSeen` VARCHAR(191) NULL,
    `lastEventPlatformId` INTEGER NULL,
    `lastEventTypeId` INTEGER NULL,
    `lastEventTime` DATETIME(3) NULL,

    UNIQUE INDEX `GeoApiTrainData_hash_key`(`hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HeartbeatError` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `heartbeatId` INTEGER NOT NULL,
    `api` ENUM('TIMES', 'GEO', 'GATEWAY') NOT NULL,
    `message` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HeartbeatWarning` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `heartbeatId` INTEGER NOT NULL,
    `api` ENUM('TIMES', 'GEO', 'GATEWAY') NOT NULL,
    `data` JSON NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Train` ADD CONSTRAINT `Train_lastActiveHeartbeatId_fkey` FOREIGN KEY (`lastActiveHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Train` ADD CONSTRAINT `Train_lastStatusChangeHeartbeatId_fkey` FOREIGN KEY (`lastStatusChangeHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Train` ADD CONSTRAINT `Train_wentInactiveHeartbeatId_fkey` FOREIGN KEY (`wentInactiveHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_trainId_fkey` FOREIGN KEY (`trainId`) REFERENCES `Train`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_startHeartbeatId_fkey` FOREIGN KEY (`startHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_endHeartbeatId_fkey` FOREIGN KEY (`endHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_parsedLastEventLocationId_fkey` FOREIGN KEY (`parsedLastEventLocationId`) REFERENCES `Platform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimesApiTrainData` ADD CONSTRAINT `TimesApiTrainData_lastEventTypeId_fkey` FOREIGN KEY (`lastEventTypeId`) REFERENCES `TrainEventType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlannedDestination` ADD CONSTRAINT `PlannedDestination_statusId_fkey` FOREIGN KEY (`statusId`) REFERENCES `TimesApiTrainData`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlannedDestination` ADD CONSTRAINT `PlannedDestination_destinationId_fkey` FOREIGN KEY (`destinationId`) REFERENCES `Destination`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_trainId_fkey` FOREIGN KEY (`trainId`) REFERENCES `Train`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_startHeartbeatId_fkey` FOREIGN KEY (`startHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_endHeartbeatId_fkey` FOREIGN KEY (`endHeartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_destinationId_fkey` FOREIGN KEY (`destinationId`) REFERENCES `Destination`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_lastEventPlatformId_fkey` FOREIGN KEY (`lastEventPlatformId`) REFERENCES `Platform`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeoApiTrainData` ADD CONSTRAINT `GeoApiTrainData_lastEventTypeId_fkey` FOREIGN KEY (`lastEventTypeId`) REFERENCES `TrainEventType`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HeartbeatError` ADD CONSTRAINT `HeartbeatError_heartbeatId_fkey` FOREIGN KEY (`heartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HeartbeatWarning` ADD CONSTRAINT `HeartbeatWarning_heartbeatId_fkey` FOREIGN KEY (`heartbeatId`) REFERENCES `Heartbeat`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
