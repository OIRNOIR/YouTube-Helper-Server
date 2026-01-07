/*
  Warnings:

  - Made the column `platform` on table `Video` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Video" ALTER COLUMN "platform" SET NOT NULL;
