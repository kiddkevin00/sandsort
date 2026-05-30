# Sandsort

A small pour-and-sort puzzle for iPhone. Tip jars of colored sand into each other until every jar is one color. No ads, no IAP, no timer.

- **Support:** https://kiddkevin00.github.io/sandsort/
- **Privacy:** https://kiddkevin00.github.io/sandsort/privacy.html

## Notes on the genre

The pour-and-sort mechanic (sometimes called Water Sort, Ball Sort, or Sand Sort) is a generic puzzle pattern with many independent implementations. Sandsort is an original take — its own UI, code, color palette, level curve, and branding. No assets, naming, or layouts from any specific app are reused.

## Stack

Expo SDK 54, React 19.1, RN 0.81, TypeScript. `expo-haptics`, AsyncStorage. Pure RN — no game-engine dependency. Per-jar pulse via `Animated`. Deterministic per-seed level generation via Mulberry32 PRNG.

## Local dev

```sh
npm install
npx expo start --tunnel
```

## App Store checklist

- [done] Bundle id `com.markutilitylabs.sandsort`, display name, version — `app.json`
- [done] Privacy + Support URLs (see top)
- [you] Apple Developer enrollment, Xcode 17+ or EAS, App Store Connect listing with "Data Not Collected" nutrition labels

## License

MIT — see `LICENSE`.
