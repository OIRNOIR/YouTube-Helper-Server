/*
  Warnings:

  - You are about to drop the column `platform_old` on the `Video` table. All the data in the column will be lost.
  - Made the column `platform` on table `Video` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Video" DROP COLUMN "platform_old",
ALTER COLUMN "platform" SET NOT NULL;
