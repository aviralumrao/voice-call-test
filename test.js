import { LevelManager, TILE_SIZE } from "./level.js";
import { Player } from "./player.js";
import { EntityManager } from "./entities.js";
import { Renderer } from "./renderer.js";
import { updatePhysics } from "./physics.js";
import { AudioAssets, playSound, startMusic, stopMusic } from "./assets.js";

const HIGH_SCORE_KEY = "marioHighScore";

function getHighScore() {
    try {
        return parseInt(localStorage.getItem(HIGH_SCORE_KEY) || "0", 10);
    } catch {
        return 0;
    }
}

function updateHighScore(score) {
    const current = getHighScore();
    if (score > current) {
        try {
            localStorage.setItem(HIGH_SCORE_KEY, score.toString());
        } catch {}
        return score;
    }
    return current;
}

export class Game {
    constructor(canvas) {
        this.canvas = canvas;
        this.levelManager = new LevelManager();
        this.player = new Player();
        this.entityManager = new EntityManager();
        this.renderer = new Renderer(canvas);

        this.gameState = "START";
        this.tick = 0;
        this.deathTimer = 0;
        this.flagWaitTimer = 0;
        this.time = 60;
        this.timeTick = 0;

        this.FLAG_X = 118 * TILE_SIZE;
        this.FLAG_TOP_Y = 3 * TILE_SIZE;
        this.FLAG_BOTTOM_Y = 12 * TILE_SIZE + 6;
        this.flagY = this.FLAG_TOP_Y;

        this.CASTLE_X = 124 * TILE_SIZE;
        this.CASTLE_Y = 8 * TILE_SIZE;
        this.CASTLE_DOOR_X = this.CASTLE_X + 64;

        this.levelManager.loadLevel(0);
        this.entityManager.loadForLevel(this.levelManager);
        stopMusic();
    }

    startLevel(levelIndex = 0) {
        this.levelManager.loadLevel(levelIndex);
        this.entityManager.loadForLevel(this.levelManager);
        this.player.resetPosition();
        this.flagY = this.FLAG_TOP_Y;
        this.gameState = "PLAYING";
        this.time = levelIndex == 0 ? 60 : 180;
        this.timeTick = 0;
        startMusic();
    }

    nextLevel() {
        this.startLevel(this.levelManager.currentLevelIndex + 1);
    }

    resetFullGame() {
        this.player.resetStats();
        this.startLevel(0);
    }

    respawn() {
        this.startLevel(this.levelManager.currentLevelIndex);
    }

    handlePlayerDeath() {
        if (["DYING", "GAMEOVER"].includes(this.gameState)) return;
        this.player.lives--;
        stopMusic();
        playSound(AudioAssets.sfxDeath);

        if (this.player.lives <= 0) {
            this.gameState = "GAMEOVER";
            const highScore = updateHighScore(this.player.score);
            document.getElementById("final-stats").innerText =
                `Final Score: ${this.player.score} | Coins: ${this.player.coins} | High Score: ${highScore}`;
            document.getElementById("gameover-screen").classList.remove("hidden");
        } else {
            this.gameState = "DYING";
            this.deathTimer = 0;
            this.player.vy = -10;
        }
    }

    showClearScreen() {
        if (this.levelManager.isLastLevel()) {
            this.showWinScreen();
            return;
        }
        document.getElementById("clear-stats").innerText =
            `Score: ${this.player.score} | Coins: ${this.player.coins}`;
        document.getElementById("clear-screen").classList.remove("hidden");
    }

    showWinScreen() {
        stopMusic();
        const highScore = updateHighScore(this.player.score);
        document.getElementById("win-stats").innerText =
            `Final Score: ${this.player.score} | Coins: ${this.player.coins} | High Score: ${highScore}`;
        document.getElementById("win-screen").classList.remove("hidden");
    }

    run() {
        const loop = () => {
            this.tick++;
            if (this.gameState === "PLAYING") {
                this.timeTick++;
                if (this.timeTick >= 60) {
                    this.timeTick = 0;
                    if (this.time > 0) {
                        this.time--;
                        if (this.time == 0) {
                            this.handlePlayerDeath();
                        }
                    }
                }
            }
            updatePhysics(this);
            this.renderer.render(this);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
}