import { usePasskeys } from './../../../utils/auth/passkeys';
import { z } from 'zod';
import { router, accountProcedure } from '../../trpc';
import { and, eq } from '@u22n/database/orm';
import { accounts, authenticators, sessions } from '@u22n/database/schema';
import { nanoIdToken, typeIdValidator, zodSchemas } from '@u22n/utils';
import {
  calculatePasswordStrength,
  strongPasswordSchema
} from '@u22n/utils/password';
import { TRPCError } from '@trpc/server';
import { useStorage } from '#imports';
import { getCookie, setCookie } from 'h3';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/types';
import { Argon2id } from 'oslo/password';
import { usePasskeysDb } from '../../../utils/auth/passkeyDbAdaptor';
import { decodeHex, encodeHex } from 'oslo/encoding';
import { TOTPController, createTOTPKeyURI } from 'oslo/otp';
import { lucia } from '../../../utils/auth';

export const securityRouter = router({
  getSecurityOverview: accountProcedure
    .input(z.object({}).strict())
    .query(async ({ ctx }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountObjectQuery = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          passwordHash: true,
          recoveryCode: true,
          twoFactorEnabled: true,
          twoFactorSecret: true
        },
        with: {
          authenticators: {
            columns: {
              publicId: true,
              createdAt: true,
              nickname: true
            }
          },
          sessions: {
            columns: {
              publicId: true,
              os: true,
              device: true,
              createdAt: true
            }
          }
        }
      });

      if (!accountObjectQuery) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Account not found'
        });
      }

      return {
        passwordSet: !!accountObjectQuery.passwordHash,
        recoveryCodeSet: !!accountObjectQuery.recoveryCode,
        twoFactorEnabled: accountObjectQuery.twoFactorEnabled,
        passkeys: accountObjectQuery.authenticators || [],
        sessions: accountObjectQuery.sessions || []
      };
    }),
  generatePasskeyVerificationChallenge: accountProcedure
    .input(z.object({}))
    .query(async ({ ctx }) => {
      const { event, account } = ctx;

      const accountQuery = await ctx.db.query.accounts.findFirst({
        where: eq(accounts.id, account.id),
        columns: {
          id: true
        }
      });

      if (!accountQuery) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Account credentials not found'
        });
      }

      const authChallengeId = nanoIdToken();

      setCookie(event, 'unauth-challenge', authChallengeId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 60 * 5
      });

      const passkeyOptions = await usePasskeys.generateAuthenticationOptions({
        authChallengeId: authChallengeId,
        accountId: accountQuery.id
      });

      return { options: passkeyOptions };
    }),
  getVerificationToken: accountProcedure
    .input(
      z.object({
        password: strongPasswordSchema.optional(),
        verificationResponseRaw: z.any()
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountObjectQuery = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true
        }
      });

      if (!accountObjectQuery) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Account not found'
        });
      }

      if (input.verificationResponseRaw) {
        const verificationResponse =
          input.verificationResponseRaw as AuthenticationResponseJSON;

        const challengeCookie = getCookie(ctx.event, 'unauth-challenge');
        if (!challengeCookie) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Challenge not found, try again'
          });
        }
        const passkeyVerification =
          await usePasskeys.verifyAuthenticationResponse({
            authenticationResponse: verificationResponse,
            authChallengeId: challengeCookie
          });

        if (
          !passkeyVerification.result.verified ||
          !passkeyVerification.result.authenticationInfo
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Passkey verification failed'
          });
        }
      }

      if (input.password) {
        const accountQuery = await db.query.accounts.findFirst({
          where: eq(accounts.id, accountId),
          columns: {
            passwordHash: true
          }
        });

        if (!accountQuery) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User not found'
          });
        }

        if (!accountQuery.passwordHash) {
          throw new TRPCError({
            code: 'METHOD_NOT_SUPPORTED',
            message: 'Password verification is not enabled'
          });
        }

        const validPassword = await new Argon2id().verify(
          accountQuery.passwordHash,
          input.password
        );
        if (!validPassword) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Password verification failed'
          });
        }
      }

      const authStorage = useStorage('auth');
      const token = nanoIdToken();
      authStorage.setItem(
        `authVerificationToken: ${accountObjectQuery.publicId}`,
        token
      );

      return {
        token: token
      };
    }),

  //* passwords
  checkPasswordStrength: accountProcedure
    .input(
      z.object({
        password: z.string()
      })
    )
    .query(({ input }) => calculatePasswordStrength(input.password)),
  disablePassword: accountProcedure
    .input(
      z.object({
        verificationToken: zodSchemas.nanoIdToken()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true,
          passwordHash: true,
          twoFactorSecret: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      await db
        .update(accounts)
        .set({
          passwordHash: null
        })
        .where(eq(accounts.id, accountId));

      return { success: true };
    }),
  setPassword: accountProcedure
    .input(
      z
        .object({
          newPassword: strongPasswordSchema,
          verificationToken: zodSchemas.nanoIdToken()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true,
          passwordHash: true,
          twoFactorSecret: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      const passwordHash = await new Argon2id().hash(input.newPassword);

      await db
        .update(accounts)
        .set({
          passwordHash
        })
        .where(eq(accounts.id, accountId));

      return { success: true };
    }),

  //* passkeys
  generateNewPasskeyChallenge: accountProcedure
    .input(
      z.object({
        verificationToken: zodSchemas.nanoIdToken(),
        authenticatorType: z.enum(['platform', 'cross-platform'])
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }

      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      const passkeyOptions = await usePasskeys.generateRegistrationOptions({
        userDisplayName: accountData.username,
        username: accountData.username,
        accountPublicId: accountData.publicId,
        authenticatorAttachment: input.authenticatorType
      });
      return { options: passkeyOptions };
    }),
  addNewPasskey: accountProcedure
    .input(
      z
        .object({
          registrationResponseRaw: z.any(),
          nickname: z.string().min(3).max(32).default('Passkey'),
          verificationToken: zodSchemas.nanoIdToken()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      const registrationResponse =
        input.registrationResponseRaw as RegistrationResponseJSON;

      const passkeyVerification = await usePasskeys.verifyRegistrationResponse({
        registrationResponse: registrationResponse,
        publicId: accountData.publicId
      });

      if (
        !passkeyVerification.verified ||
        !passkeyVerification.registrationInfo
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey verification failed'
        });
      }

      const accountQuery = await db.query.accounts.findFirst({
        where: eq(accounts.id, account.id),
        columns: {
          id: true
        }
      });

      if (!accountQuery || !accountQuery.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'User account not found'
        });
      }

      const insertPasskey = await usePasskeysDb.createAuthenticator(
        {
          accountId: accountQuery.id,
          credentialID: passkeyVerification.registrationInfo.credentialID,
          credentialPublicKey:
            passkeyVerification.registrationInfo.credentialPublicKey,
          credentialDeviceType:
            passkeyVerification.registrationInfo.credentialDeviceType,
          credentialBackedUp:
            passkeyVerification.registrationInfo.credentialBackedUp,
          transports: registrationResponse.response.transports,
          counter: passkeyVerification.registrationInfo.counter
        },
        input.nickname
      );

      if (!insertPasskey.credentialID) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Something went wrong adding your passkey, please try again'
        });
      }

      return { success: true };
    }),
  deletePasskey: accountProcedure
    .input(
      z
        .object({
          passkeyPublicId: typeIdValidator('accountPasskey'),
          verificationToken: zodSchemas.nanoIdToken()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true,
          passwordHash: true,
          twoFactorSecret: true
        },
        with: {
          authenticators: {
            columns: {
              id: true
            }
          }
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      const hasPassword = !!accountData.passwordHash;
      const hasOtherPassKeys = accountData.authenticators.length > 1;

      if (!hasPassword && !hasOtherPassKeys) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You must have at least one passkey, or a password set.'
        });
      }

      await db
        .delete(authenticators)
        .where(eq(authenticators.publicId, input.passkeyPublicId));

      return { success: true };
    }),
  disable2FA: accountProcedure
    .input(
      z
        .object({
          verificationToken: zodSchemas.nanoIdToken(),
          twoFactorCode: z.string()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { account, db } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          twoFactorSecret: true,
          recoveryCode: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }
      if (accountData.twoFactorSecret) {
        const secret = decodeHex(accountData.twoFactorSecret);
        const isValid = await new TOTPController().verify(
          input.twoFactorCode,
          secret
        );
        if (!isValid) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid 2FA code'
          });
        }
      }

      await db
        .update(accounts)
        .set({ twoFactorSecret: null, recoveryCode: null })
        .where(eq(accounts.id, accountId));

      return { success: true };
    }),
  createTwoFactorSecret: accountProcedure
    .input(z.object({ verificationToken: zodSchemas.nanoIdToken() }).strict())
    .mutation(async ({ ctx, input }) => {
      const { account, db } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          publicId: true,
          username: true,
          twoFactorSecret: true,
          recoveryCode: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      const newSecret = crypto.getRandomValues(new Uint8Array(20));
      await db
        .update(accounts)
        .set({ twoFactorSecret: encodeHex(newSecret) })
        .where(eq(accounts.id, accountId));
      const uri = createTOTPKeyURI(
        'UnInbox.com',
        accountData.username,
        newSecret
      );
      return { uri };
    }),
  verifyTwoFactor: accountProcedure
    .input(
      z
        .object({
          twoFactorCode: z.string()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { account, db } = ctx;
      const accountId = account.id;

      const existingData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          twoFactorSecret: true,
          recoveryCode: true,
          twoFactorEnabled: true
        }
      });

      if (!existingData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!existingData.twoFactorSecret) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Two Factor Authentication (2FA) is not set up for this account'
        });
      }

      const secret = decodeHex(existingData.twoFactorSecret);
      const isValid = await new TOTPController().verify(
        input.twoFactorCode,
        secret
      );
      if (!isValid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid Two Factor Authentication (2FA) code'
        });
      }

      // generate and return the recovery codes
      const recoveryCode = nanoIdToken();
      const hashedRecoveryCode = await new Argon2id().hash(recoveryCode);

      await db
        .update(accounts)
        .set({ recoveryCode: hashedRecoveryCode, twoFactorEnabled: true })
        .where(eq(accounts.id, accountId));

      return { recoveryCode: recoveryCode };
    }),
  deleteSession: accountProcedure
    .input(
      z
        .object({
          sessionPublicId: typeIdValidator('accountSession'),
          verificationToken: zodSchemas.nanoIdToken()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          id: true,
          publicId: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      const sessionQuery = await db.query.sessions.findFirst({
        where: and(
          eq(sessions.publicId, input.sessionPublicId),
          eq(sessions.accountId, accountData.id)
        ),
        columns: {
          sessionToken: true
        }
      });

      if (!sessionQuery) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Session not found'
        });
      }

      await lucia.invalidateSession(sessionQuery.sessionToken);

      return { success: true };
    }),
  deleteAllSessions: accountProcedure
    .input(
      z
        .object({
          verificationToken: zodSchemas.nanoIdToken()
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { db, account } = ctx;
      const accountId = account.id;

      const accountData = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
        columns: {
          id: true,
          publicId: true
        }
      });

      if (!accountData) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }

      if (!input.verificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is required'
        });
      }
      const authStorage = useStorage('auth');

      const storedVerificationToken = await authStorage.getItem(
        `authVerificationToken: ${accountData.publicId}`
      );

      if (input.verificationToken !== storedVerificationToken) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'VerificationToken is invalid'
        });
      }

      await lucia.invalidateUserSessions(accountData.id);

      return { success: true };
    })
});
