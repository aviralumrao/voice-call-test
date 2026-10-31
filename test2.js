import { Level1 } from './level1.js';
import { Level2 } from './level2.js';


export const SCALE = 2;
export const TILE_SIZE = 16 * SCALE;

export class LevelManager {
    constructor() {
        this.levels = [Level1, Level2];
        this.currentLevelIndex = 0;
        this.currentLevel = null;
        this.tiles = [];
    }

    loadLevel(index) {
        this.currentLevelIndex = index % this.levels.length;
        this.currentLevel = this.levels[this.currentLevelIndex];

        const map = this.currentLevel.map;
        this.mapH = map.length;
        this.mapW = map[0].length;
        this.tiles = [];

        for (let r = 0; r < this.mapH; r++) {
            this.tiles[r] = [];
            for (let c = 0; c < this.mapW; c++) {
                const raw = map[r][c];
                const ch = typeof raw === 'number' ? String(raw) : raw;
                this.tiles[r][c] = ch === '1' ? 1 : ch === '2' ? 2 : ch === '3' ? 3 : ch === 'S' ? 5 : 0;
            }
        }

        if (this.currentLevel.pipes) {
            this.currentLevel.pipes.forEach(p => {
                for (let py = 0; py < p.height; py++) {
                    const row = p.y + py;
                    if (row >= 0 && row < this.mapH && p.x >= 0 && p.x + 1 < this.mapW) {
                        this.tiles[row][p.x] = 1;
                        this.tiles[row][p.x + 1] = 1;
                    }
                }
            });
        }
    }

    isLastLevel() {
        return this.currentLevelIndex === this.levels.length - 1;
    }

    getTile(tx, ty) {
        if (tx < 0 || tx >= this.mapW || ty < 0 || ty >= this.mapH) return 0;
        return this.tiles[ty][tx];
    }

    setTile(tx, ty, value) {
        if (tx >= 0 && tx < this.mapW && ty >= 0 && ty < this.mapH) {
            this.tiles[ty][tx] = value;
        }
    }

    getEnemies() {
        if (!this.currentLevel) return [];
        return this.currentLevel.getEnemies(TILE_SIZE);
    }

    getCoins() {
        if (!this.currentLevel) return [];
        return this.currentLevel.getCoins();
    }

    getPipes() {
        if (!this.currentLevel) return [];
        return this.currentLevel.pipes.map(p => ({
            x: p.x * TILE_SIZE,
            y: p.y * TILE_SIZE,
            height: p.height
        }));
    }

    getScenery() {
        if (!this.currentLevel) return [];
        return this.currentLevel.scenery;
    }

    get levelName() {
        return this.currentLevel ? this.currentLevel.name : "1-1";
    }
}