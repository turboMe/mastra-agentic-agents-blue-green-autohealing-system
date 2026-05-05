/**
 * Chef DB helper — delegates to shared mongo singleton.
 * Kept as separate file so chef-service.ts can import without changing its own imports.
 */
import type { Db } from 'mongodb';
import { getDb as getSharedDb } from '../../lib/mongo';

export async function getDb(): Promise<Db> {
  return getSharedDb();
}

export async function ensureChefIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('chef_projects').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_menus').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_menus').createIndex({ projectId: 1, version: -1 }),
    db.collection('chef_recipes').createIndex({ id: 1 }, { unique: true }),
    db.collection('chef_recipes').createIndex({ projectId: 1, dishName: 1 }),
    db.collection('chef_notes').createIndex({ type: 1, topic: 1 }),
    db.collection('chef_notes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true }),
  ]);
}
