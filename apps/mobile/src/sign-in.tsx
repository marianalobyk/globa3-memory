import { useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, API_URL } from './api';
import { useAuth } from './auth';
import { Body, Button, ErrorNote, Small, Title, usePalette, styles } from './ui';

/**
 * Sign-in. The email and password go to the Globa 3 server over HTTPS, which
 * checks them with the configured provider; the app keeps only the resulting
 * session token, in the Keychain. The password is never stored.
 */
export function SignIn() {
  const { signIn } = useAuth();
  const p = usePalette();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const input = [
    styles.body,
    { borderWidth: 1, borderColor: p.line, borderRadius: 12, padding: 14, color: p.ink, backgroundColor: p.card },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.ground }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={[styles.screen, { flex: 1, justifyContent: 'center' }]}>
          <Title>Globa 3</Title>
          <Body muted>Capture what matters after a meeting. Nothing is remembered until you approve it.</Body>
          <TextInput
            accessibilityLabel="Email"
            placeholder="Email"
            placeholderTextColor={p.muted}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            value={email}
            onChangeText={setEmail}
            style={input}
          />
          <TextInput
            accessibilityLabel="Password"
            placeholder="Password"
            placeholderTextColor={p.muted}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={submit}
            style={input}
          />
          <ErrorNote message={error} />
          <Button label="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />
          {/* Which server this build talks to matters while developing, not to the person signing in. */}
          {__DEV__ ? <Small>Server: {API_URL}</Small> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
