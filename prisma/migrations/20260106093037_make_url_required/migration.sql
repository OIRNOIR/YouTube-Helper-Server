/*
  Warnings:

  - Made the column `url` on table `Video` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Video" ALTER COLUMN "url" SET NOT NULL;
