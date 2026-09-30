import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth';
import { SignIn } from '@/sign-in';
import { Loading, usePalette } from '@/ui';

function Gate() {
  const { status } = useAuth();
  const p = usePalette();
  if (status === 'loading') return <Loading />;
  if (status === 'signed-out') return <SignIn />;
  return (
    <Stack
      screenOptions={{
        headerTintColor: p.accent,
        headerStyle: { backgroundColor: p.ground },
        headerTitleStyle: { color: p.ink },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: p.ground },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="capture/[id]" options={{ title: 'Capture' }} />
      <Stack.Screen name="proposal/[id]" options={{ title: 'Review' }} />
      <Stack.Screen name="saved/[id]" options={{ title: 'Saved' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
