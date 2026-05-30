import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const STORAGE_KEY = 'sandsort:state:v1';
const JAR_CAPACITY = 4;

// Earthy / sand-and-sea palette — distinct hues that read well next to
// each other inside narrow jars.
const PALETTE: string[] = [
  '#c75a2a', // terracotta
  '#5f8fae', // slate blue
  '#87a96b', // sage
  '#c9b037', // mustard
  '#b85450', // rust
  '#6b5b8c', // mauve
  '#4a8e8e', // teal
  '#d9943a', // sand-amber
];

type Jar = string[]; // bottom → top stack of color hexes
type Board = Jar[];

type LevelConfig = { colors: number; emptyJars: number };

// Sequential difficulty curve. Indices line up with `level - 1`.
const LEVELS: LevelConfig[] = [
  { colors: 3, emptyJars: 2 },
  { colors: 4, emptyJars: 2 },
  { colors: 5, emptyJars: 2 },
  { colors: 6, emptyJars: 2 },
  { colors: 7, emptyJars: 2 },
  { colors: 8, emptyJars: 2 },
  { colors: 6, emptyJars: 1 },
  { colors: 8, emptyJars: 1 },
];

type SavedState = {
  level: number; // 1-indexed
  unlocked: number; // highest level unlocked
  bestMovesByLevel: Record<number, number>;
  haptics: boolean;
};

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Mulberry32 — deterministic PRNG so a given (level, seed) reproduces.
function rngFromSeed(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLevel(cfg: LevelConfig, seed: number): Board {
  const rng = rngFromSeed(seed);
  const colors = PALETTE.slice(0, cfg.colors);
  // Fill each color JAR_CAPACITY times, then shuffle units, then chunk.
  const units: string[] = [];
  for (const c of colors) {
    for (let i = 0; i < JAR_CAPACITY; i++) units.push(c);
  }
  // Re-roll if the shuffle happens to produce an already-sorted jar
  // (a tube where every unit is identical), since that's boring.
  for (let attempt = 0; attempt < 8; attempt++) {
    shuffleInPlace(units, rng);
    const board: Board = [];
    for (let i = 0; i < colors.length; i++) {
      board.push(units.slice(i * JAR_CAPACITY, (i + 1) * JAR_CAPACITY));
    }
    const anySorted = board.some(
      (j) => j.length === JAR_CAPACITY && j.every((c) => c === j[0]),
    );
    if (!anySorted) {
      for (let i = 0; i < cfg.emptyJars; i++) board.push([]);
      return board;
    }
  }
  // Fallback if 8 reshuffles all came up clean (very unlikely).
  const board: Board = [];
  for (let i = 0; i < colors.length; i++) {
    board.push(units.slice(i * JAR_CAPACITY, (i + 1) * JAR_CAPACITY));
  }
  for (let i = 0; i < cfg.emptyJars; i++) board.push([]);
  return board;
}

function topColor(jar: Jar): string | null {
  return jar.length === 0 ? null : jar[jar.length - 1];
}

function topRunLength(jar: Jar): number {
  if (jar.length === 0) return 0;
  const t = jar[jar.length - 1];
  let n = 0;
  for (let i = jar.length - 1; i >= 0; i--) {
    if (jar[i] === t) n++;
    else break;
  }
  return n;
}

function canPour(src: Jar, dst: Jar): boolean {
  if (src.length === 0) return false;
  if (dst.length >= JAR_CAPACITY) return false;
  const dt = topColor(dst);
  return dt == null || dt === topColor(src);
}

function pourAmount(src: Jar, dst: Jar): number {
  if (!canPour(src, dst)) return 0;
  const want = topRunLength(src);
  const room = JAR_CAPACITY - dst.length;
  return Math.min(want, room);
}

function applyPour(board: Board, srcIdx: number, dstIdx: number): Board | null {
  const src = board[srcIdx];
  const dst = board[dstIdx];
  const n = pourAmount(src, dst);
  if (n === 0) return null;
  const next = board.map((j) => j.slice());
  const moved = next[srcIdx].splice(next[srcIdx].length - n, n);
  next[dstIdx].push(...moved);
  return next;
}

function isSolved(board: Board): boolean {
  for (const j of board) {
    if (j.length === 0) continue;
    if (j.length !== JAR_CAPACITY) return false;
    const first = j[0];
    for (const c of j) if (c !== first) return false;
  }
  return true;
}

function anyMoveAvailable(board: Board): boolean {
  for (let i = 0; i < board.length; i++) {
    for (let j = 0; j < board.length; j++) {
      if (i === j) continue;
      if (canPour(board[i], board[j])) return true;
    }
  }
  return false;
}

const { width: SCREEN_W } = Dimensions.get('window');

export default function App() {
  const [level, setLevel] = useState(1);
  const [unlocked, setUnlocked] = useState(1);
  const [seed, setSeed] = useState<number>(() => Math.floor(Math.random() * 0xffffffff));
  const [board, setBoard] = useState<Board>(() => buildLevel(LEVELS[0], 1));
  const [history, setHistory] = useState<Board[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [moves, setMoves] = useState(0);
  const [bestMovesByLevel, setBestMovesByLevel] = useState<Record<number, number>>({});
  const [haptics, setHaptics] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [winOpen, setWinOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Pulse animations keyed by jar index.
  const pulseRefs = useRef<Map<number, Animated.Value>>(new Map());
  const getPulse = useCallback((i: number) => {
    if (!pulseRefs.current.has(i)) pulseRefs.current.set(i, new Animated.Value(1));
    return pulseRefs.current.get(i)!;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const s = JSON.parse(raw) as Partial<SavedState>;
          if (typeof s.level === 'number') setLevel(s.level);
          if (typeof s.unlocked === 'number') setUnlocked(s.unlocked);
          if (s.bestMovesByLevel && typeof s.bestMovesByLevel === 'object') {
            setBestMovesByLevel(s.bestMovesByLevel);
          }
          if (typeof s.haptics === 'boolean') setHaptics(s.haptics);
        }
      } catch {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        level,
        unlocked,
        bestMovesByLevel,
        haptics,
      } satisfies SavedState),
    ).catch(() => {});
  }, [level, unlocked, bestMovesByLevel, haptics, loaded]);

  // Rebuild board whenever level (or seed) changes.
  useEffect(() => {
    const cfg = LEVELS[Math.min(level - 1, LEVELS.length - 1)];
    setBoard(buildLevel(cfg, seed));
    setHistory([]);
    setSelected(null);
    setMoves(0);
    setWinOpen(false);
  }, [level, seed]);

  const tap = useCallback(
    (kind: 'light' | 'success' | 'warning' | 'medium' = 'light') => {
      if (!haptics) return;
      if (kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      else if (kind === 'warning') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      else if (kind === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      else Haptics.selectionAsync().catch(() => {});
    },
    [haptics],
  );

  const pulse = useCallback(
    (i: number) => {
      const v = getPulse(i);
      Animated.sequence([
        Animated.timing(v, { toValue: 1.06, duration: 90, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 140, useNativeDriver: true }),
      ]).start();
    },
    [getPulse],
  );

  const tapJar = useCallback(
    (idx: number) => {
      if (winOpen) return;
      if (selected === null) {
        if (board[idx].length === 0) return; // can't pick up an empty jar
        setSelected(idx);
        tap('light');
        return;
      }
      if (selected === idx) {
        setSelected(null);
        tap('light');
        return;
      }
      const next = applyPour(board, selected, idx);
      if (!next) {
        // Invalid target — switch selection if the new target has sand,
        // else deselect.
        if (board[idx].length > 0) {
          setSelected(idx);
          tap('light');
        } else {
          setSelected(null);
          tap('warning');
        }
        return;
      }
      setHistory((h) => [...h, board]);
      setBoard(next);
      setMoves((m) => m + 1);
      setSelected(null);
      pulse(idx);
      tap('medium');
      if (isSolved(next)) {
        tap('success');
        const finalMoves = moves + 1;
        setBestMovesByLevel((prev) => {
          const existing = prev[level];
          if (existing == null || finalMoves < existing) {
            return { ...prev, [level]: finalMoves };
          }
          return prev;
        });
        setUnlocked((u) => Math.max(u, Math.min(level + 1, LEVELS.length)));
        setWinOpen(true);
      }
    },
    [board, selected, moves, level, winOpen, pulse, tap],
  );

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setBoard(last);
    setHistory((h) => h.slice(0, -1));
    setSelected(null);
    setMoves((m) => Math.max(0, m - 1));
    tap('light');
  }, [history, tap]);

  const restart = useCallback(() => {
    const cfg = LEVELS[Math.min(level - 1, LEVELS.length - 1)];
    setBoard(buildLevel(cfg, seed));
    setHistory([]);
    setSelected(null);
    setMoves(0);
    tap('medium');
  }, [level, seed, tap]);

  const newSeed = useCallback(() => {
    setSeed(Math.floor(Math.random() * 0xffffffff));
  }, []);

  const goToLevel = useCallback(
    (lvl: number) => {
      const clamped = Math.max(1, Math.min(LEVELS.length, lvl));
      if (clamped > unlocked) return;
      setLevel(clamped);
      newSeed();
      setMenuOpen(false);
    },
    [unlocked, newSeed],
  );

  const stuck = useMemo(() => !winOpen && !anyMoveAvailable(board), [board, winOpen]);

  const best = bestMovesByLevel[level];

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />

      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>
            Sand<Text style={styles.brandItalic}>sort</Text>
          </Text>
          <Text style={styles.brandSub}>
            Level {level} · {moves} {moves === 1 ? 'move' : 'moves'}
            {best != null ? ` · best ${best}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={() => setMenuOpen(true)}
          style={({ pressed }) => [styles.menuBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <Text style={styles.menuBtnText}>•••</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.boardWrap}
        showsVerticalScrollIndicator={false}
      >
        <BoardView
          board={board}
          selected={selected}
          onTap={tapJar}
          getPulse={getPulse}
        />
        {stuck && (
          <View style={styles.stuckBanner}>
            <Text style={styles.stuckTitle}>No pours available</Text>
            <Text style={styles.stuckSub}>
              Tap Undo to roll back, or Restart to reshuffle the level.
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.bottomBar}>
        <BarBtn label="Undo" onPress={undo} disabled={history.length === 0} />
        <BarBtn label="Restart" onPress={restart} />
        <BarBtn label="New deal" onPress={newSeed} />
      </View>

      {/* Win modal */}
      <Modal visible={winOpen} transparent animationType="fade" onRequestClose={() => setWinOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalEyebrow}>LEVEL {level} CLEARED</Text>
            <Text style={styles.modalBig}>{moves}</Text>
            <Text style={styles.modalSub}>{moves === 1 ? 'move' : 'moves'}</Text>
            <Text style={styles.modalHint}>
              {best === moves
                ? 'New best for this level.'
                : best != null
                  ? `Your best is ${best} ${best === 1 ? 'move' : 'moves'}.`
                  : ''}
            </Text>
            {level < LEVELS.length ? (
              <Pressable
                onPress={() => {
                  setLevel((l) => l + 1);
                  newSeed();
                }}
                style={({ pressed }) => [styles.modalPrimary, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.modalPrimaryText}>Next level</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={restart}
                style={({ pressed }) => [styles.modalPrimary, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.modalPrimaryText}>Play again</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                newSeed();
                setWinOpen(false);
              }}
              style={styles.modalLinkBtn}
            >
              <Text style={styles.modalLinkText}>Stay on level {level}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Menu modal: rules, level picker, settings */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { maxWidth: 420 }]}>
            <Text style={styles.modalEyebrow}>HOW TO PLAY</Text>
            <Text style={styles.modalRule}>
              Tap a jar to pick it up, then tap another jar to pour. You
              can only pour onto an <Text style={styles.bold}>empty</Text>{' '}
              jar or onto sand of the{' '}
              <Text style={styles.bold}>same color</Text>.
            </Text>
            <Text style={styles.modalRule}>
              The whole top run of the source color pours at once (or as
              much as fits). Clear every jar to one color to finish the
              level.
            </Text>
            <Text style={[styles.modalEyebrow, { marginTop: 18 }]}>JUMP TO LEVEL</Text>
            <View style={styles.levelGrid}>
              {LEVELS.map((_, i) => {
                const n = i + 1;
                const locked = n > unlocked;
                const current = n === level;
                const lvlBest = bestMovesByLevel[n];
                return (
                  <Pressable
                    key={n}
                    onPress={() => goToLevel(n)}
                    disabled={locked}
                    style={({ pressed }) => [
                      styles.levelCell,
                      current && styles.levelCellCurrent,
                      locked && styles.levelCellLocked,
                      pressed && !locked && { opacity: 0.85 },
                    ]}
                  >
                    <Text style={[styles.levelN, locked && styles.levelNLocked]}>
                      {locked ? '🔒' : n}
                    </Text>
                    {!locked && lvlBest != null && (
                      <Text style={styles.levelBest}>{lvlBest}</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.menuActions}>
              <Pressable
                onPress={() => setHaptics((h) => !h)}
                style={styles.modalLinkBtn}
                hitSlop={8}
              >
                <Text style={styles.modalLinkText}>
                  {haptics ? '◉ Haptics on' : '◯ Haptics off'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  Alert.alert('Reset progress?', 'Clear best moves and locked levels.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Reset',
                      style: 'destructive',
                      onPress: () => {
                        setBestMovesByLevel({});
                        setUnlocked(1);
                        setLevel(1);
                        newSeed();
                      },
                    },
                  ]);
                }}
                style={styles.modalLinkBtn}
                hitSlop={8}
              >
                <Text style={[styles.modalLinkText, { color: COLORS.warn }]}>Reset progress</Text>
              </Pressable>
            </View>
            <Pressable
              onPress={() => setMenuOpen(false)}
              style={({ pressed }) => [styles.modalPrimary, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.modalPrimaryText}>Got it</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function BarBtn({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.barBtn,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={styles.barBtnText}>{label}</Text>
    </Pressable>
  );
}

function BoardView({
  board,
  selected,
  onTap,
  getPulse,
}: {
  board: Board;
  selected: number | null;
  onTap: (i: number) => void;
  getPulse: (i: number) => Animated.Value;
}) {
  // Lay out jars in rows that fit the screen comfortably. Aim for ~4
  // per row on a normal iPhone width.
  const desiredJarWidth = 64;
  const perRow = Math.max(3, Math.min(5, Math.floor((SCREEN_W - 24) / (desiredJarWidth + 16))));
  const rows: number[][] = [];
  for (let i = 0; i < board.length; i += perRow) {
    rows.push([...Array(Math.min(perRow, board.length - i))].map((_, k) => i + k));
  }
  return (
    <View style={{ gap: 22 }}>
      {rows.map((row, ri) => (
        <View key={ri} style={styles.jarRow}>
          {row.map((i) => (
            <JarView
              key={i}
              jar={board[i]}
              selected={selected === i}
              pulse={getPulse(i)}
              onTap={() => onTap(i)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const JAR_W = 60;
const JAR_H = 180;
const NECK_H = 10;

function JarView({
  jar,
  selected,
  pulse,
  onTap,
}: {
  jar: Jar;
  selected: boolean;
  pulse: Animated.Value;
  onTap: () => void;
}) {
  const slotH = (JAR_H - NECK_H * 2) / JAR_CAPACITY;
  return (
    <Animated.View
      style={[
        styles.jarOuter,
        { transform: [{ scale: pulse }, ...(selected ? [{ translateY: -10 }] : [])] },
      ]}
    >
      <Pressable onPress={onTap} hitSlop={6}>
        <View style={[styles.jar, selected && styles.jarSelected]}>
          <View style={styles.jarNeck} />
          <View style={styles.jarBody}>
            {/* Empty slots above; sand fills from the bottom. */}
            {Array.from({ length: JAR_CAPACITY }).map((_, slot) => {
              // index from bottom: slot 0 == bottom-most slot
              const fromBottom = JAR_CAPACITY - 1 - slot;
              const color = jar[fromBottom];
              return (
                <View
                  key={slot}
                  style={{
                    height: slotH,
                    backgroundColor: color ?? 'transparent',
                  }}
                />
              );
            })}
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const COLORS = {
  bg: '#f5f0e4',
  card: '#fffefa',
  ink: '#1f1a14',
  inkMuted: '#5a534a',
  inkSubtle: '#94897c',
  rule: '#d8cfb9',
  accent: '#c75a2a',
  accentDeep: '#8a3818',
  accentSoft: '#f3dccc',
  glass: '#e0d7c2',
  warn: '#a74220',
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 22, paddingTop: 8, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.rule,
  },
  brand: { fontSize: 26, fontWeight: '700', color: COLORS.ink, letterSpacing: -0.4 },
  brandItalic: { fontStyle: 'italic', color: COLORS.accent, fontWeight: '600' },
  brandSub: { fontSize: 12, color: COLORS.inkSubtle, marginTop: 2 },
  menuBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  menuBtnText: { color: COLORS.inkMuted, fontSize: 22, lineHeight: 22 },

  boardWrap: { padding: 22, paddingBottom: 12 },
  jarRow: { flexDirection: 'row', justifyContent: 'center', gap: 16 },

  jarOuter: {
    alignItems: 'center',
  },
  jar: {
    width: JAR_W,
    height: JAR_H,
    alignItems: 'center',
  },
  jarSelected: {},
  jarNeck: {
    width: JAR_W * 0.55,
    height: NECK_H,
    backgroundColor: COLORS.glass,
    borderTopLeftRadius: 4, borderTopRightRadius: 4,
    borderBottomLeftRadius: 1, borderBottomRightRadius: 1,
    marginBottom: 0,
  },
  jarBody: {
    width: JAR_W,
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 14,
    borderTopLeftRadius: 4, borderTopRightRadius: 4,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: COLORS.glass,
  },

  stuckBanner: {
    marginTop: 24, padding: 16,
    backgroundColor: COLORS.accentSoft,
    borderRadius: 12,
    alignItems: 'center',
  },
  stuckTitle: { fontSize: 14, fontWeight: '700', color: COLORS.accentDeep },
  stuckSub: { fontSize: 12, color: COLORS.accentDeep, marginTop: 4, textAlign: 'center' },

  bottomBar: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 22, paddingTop: 12, paddingBottom: 22,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.rule,
  },
  barBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', backgroundColor: COLORS.card,
    borderWidth: 1, borderColor: COLORS.rule,
  },
  barBtnText: { color: COLORS.ink, fontSize: 14, fontWeight: '600', letterSpacing: 0.3 },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(20,16,10,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  modalCard: {
    backgroundColor: COLORS.card, borderRadius: 20,
    padding: 26, width: '100%', maxWidth: 360,
    alignItems: 'center',
  },
  modalEyebrow: { fontSize: 11, color: COLORS.accent, letterSpacing: 2.5, fontWeight: '700' },
  modalBig: { fontSize: 56, color: COLORS.ink, fontWeight: '300', marginTop: 6, fontVariant: ['tabular-nums'] },
  modalSub: { fontSize: 13, color: COLORS.inkMuted, marginBottom: 14, fontVariant: ['tabular-nums'] },
  modalHint: { fontSize: 13, color: COLORS.inkMuted, marginBottom: 18, textAlign: 'center' },
  modalRule: { fontSize: 13, color: COLORS.inkMuted, marginTop: 10, lineHeight: 19, alignSelf: 'stretch' },
  bold: { color: COLORS.ink, fontWeight: '600' },

  levelGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    alignSelf: 'stretch', marginTop: 10,
  },
  levelCell: {
    width: 52, height: 52, borderRadius: 12,
    backgroundColor: COLORS.bg,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: COLORS.rule,
  },
  levelCellCurrent: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  levelCellLocked: { opacity: 0.5 },
  levelN: { fontSize: 18, color: COLORS.ink, fontWeight: '700' },
  levelNLocked: { fontSize: 14 },
  levelBest: { fontSize: 9, color: COLORS.inkSubtle, marginTop: 1 },

  modalPrimary: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: 28, paddingVertical: 12, borderRadius: 999,
    marginTop: 16,
  },
  modalPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: 0.3 },
  modalLinkBtn: { paddingVertical: 8 },
  modalLinkText: { color: COLORS.inkMuted, fontSize: 13, letterSpacing: 0.5 },
  menuActions: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignSelf: 'stretch', marginTop: 14, marginBottom: 4,
  },
});
