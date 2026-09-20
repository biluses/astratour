import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { getSql } from '@/lib/db';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: '/', error: '/' },
  callbacks: {
    async signIn({ account, profile }) {
      return account?.provider === 'google' && profile?.email_verified === true &&
        typeof profile.sub === 'string' && typeof profile.email === 'string';
    },
    async jwt({ token, account, profile }) {
      if (account?.provider === 'google' && profile?.sub && profile.email_verified === true) {
        const sql = getSql();
        // Google subject is immutable. Never identify users by a client-supplied ID or email alone.
        const [user] = await sql`
          INSERT INTO app_users (google_sub, email, name, image)
          VALUES (${profile.sub}, ${profile.email!}, ${profile.name ?? null}, ${profile.picture ?? null})
          ON CONFLICT (google_sub) DO UPDATE SET
            email = EXCLUDED.email, name = EXCLUDED.name, image = EXCLUDED.image
          RETURNING id`;
        token.userId = user.id as string;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.userId === 'string') session.user.id = token.userId;
      return session;
    },
  },
});
