import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { usePalette } from '@/ui';

const GLYPHS: Record<string, string> = { index: '◎', capture: '+', review: '✓', knowledge: '⌕' };

/** Four tabs, in the order the work flows: Today, Capture, Review, Knowledge. */
export default function TabsLayout() {
  const p = usePalette();
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: p.ground },
        headerTitleStyle: { color: p.ink },
        headerShadowVisible: false,
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.muted,
        tabBarStyle: { backgroundColor: p.card, borderTopColor: p.line },
        sceneStyle: { backgroundColor: p.ground },
        tabBarIcon: ({ color }) => (
          <Text accessible={false} style={{ color, fontSize: 20, lineHeight: 24 }}>
            {GLYPHS[route.name] ?? '•'}
          </Text>
        ),
      })}
    >
      <Tabs.Screen name="index" options={{ title: 'Today', headerShown: false }} />
      <Tabs.Screen name="capture" options={{ title: 'Capture' }} />
      <Tabs.Screen name="review" options={{ title: 'Review' }} />
      <Tabs.Screen name="knowledge" options={{ title: 'Knowledge' }} />
    </Tabs>
  );
}
