// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, it, expect } from 'vitest';
import arTranslations from '@i18n/ar.json';
import enTranslations from '@i18n/en.json';
import esTranslations from '@i18n/es.json';
import jaTranslations from '@i18n/ja.json';
import koTranslations from '@i18n/ko.json';
import zhCnTranslations from '@i18n/zh-CN.json';
import { LOCALES } from '../../../src/types/i18n-types';

const allTranslations = {
  en: enTranslations,
  ko: koTranslations,
  ja: jaTranslations,
  'zh-CN': zhCnTranslations,
  es: esTranslations,
  ar: arTranslations,
};

describe('translations', () => {
  describe('en.json and ko.json key parity', () => {
    it('has the same number of keys in both locales', () => {
      const enKeys = Object.keys(enTranslations);
      const koKeys = Object.keys(koTranslations);
      expect(enKeys.length).toBe(koKeys.length);
    });

    it('has all translation keys in en.json', () => {
      const enKeys = Object.keys(enTranslations);
      expect(enKeys.length).toBe(177);
    });

    it('has all translation keys in ko.json', () => {
      const koKeys = Object.keys(koTranslations);
      expect(koKeys.length).toBe(177);
    });

    it('en.json keys are a subset of ko.json keys', () => {
      const koKeysSet = new Set(Object.keys(koTranslations));
      for (const key of Object.keys(enTranslations)) {
        expect(koKeysSet.has(key)).toBe(true);
      }
    });

    it('ko.json keys are a subset of en.json keys', () => {
      const enKeysSet = new Set(Object.keys(enTranslations));
      for (const key of Object.keys(koTranslations)) {
        expect(enKeysSet.has(key)).toBe(true);
      }
    });

    it('en and ko have identical key sets', () => {
      const enKeys = Object.keys(enTranslations).sort();
      const koKeys = Object.keys(koTranslations).sort();
      expect(enKeys).toEqual(koKeys);
    });

    it('all six locales have identical key sets', () => {
      const enKeys = Object.keys(enTranslations).sort();
      for (const translations of Object.values(allTranslations)) {
        expect(Object.keys(translations).sort()).toEqual(enKeys);
      }
    });
  });

  describe('no empty string values', () => {
    it('en.json has no empty string values', () => {
      for (const [key, value] of Object.entries(enTranslations)) {
        expect(value, `en.json key "${key}" should not be empty`).not.toBe('');
        expect(typeof value).toBe('string');
      }
    });

    it('ko.json has no empty string values', () => {
      for (const [key, value] of Object.entries(koTranslations)) {
        expect(value, `ko.json key "${key}" should not be empty`).not.toBe('');
        expect(typeof value).toBe('string');
      }
    });

    it('en.json values are all non-empty strings', () => {
      const values = Object.values(enTranslations);
      for (const value of values) {
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('ko.json values are all non-empty strings', () => {
      const values = Object.values(koTranslations);
      for (const value of values) {
        expect(value.length).toBeGreaterThan(0);
      }
    });
  });

  describe('LOCALES codes match JSON file names', () => {
    it('LOCALES includes en and ko', () => {
      const codes = LOCALES.map((l) => l.code);
      expect(codes).toContain('en');
      expect(codes).toContain('ko');
    });

    it('each LOCALES code corresponds to a JSON file', () => {
      // The JSON files available in the locales directory
      const availableLocaleFiles = ['en', 'ko', 'ja', 'zh-CN', 'es', 'ar'];
      for (const locale of LOCALES) {
        expect(availableLocaleFiles).toContain(locale.code);
      }
    });

    it('LOALES has 6 locales total', () => {
      expect(LOCALES).toHaveLength(6);
    });

    it('all LOCALES codes are unique', () => {
      const codes = LOCALES.map((l) => l.code);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });
  });

  describe('translation key structure', () => {
    it('all keys follow dot notation (section.subsection.element)', () => {
      const enKeys = Object.keys(enTranslations);
      for (const key of enKeys) {
        expect(key).toContain('.');
        const parts = key.split('.');
        expect(parts.length).toBeGreaterThanOrEqual(2);
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
        }
      }
    });

    it('top-level sections are consistent', () => {
      const enKeys = Object.keys(enTranslations);
      const sections = new Set(enKeys.map((k) => k.split('.')[0]));

      // Expected top-level sections
      const expectedSections = [
        'app',
        'header',
        'footer',
        'dropzone',
        'metadata',
        'settings',
        'format',
        'quality',
        'scale',
        'frameSkip',
        'trim',
        'progress',
        'result',
        'error',
        'validation',
        'memory',
        'modal',
        'env',
        'offline',
        'lang',
      ];

      for (const section of expectedSections) {
        expect(sections.has(section), `Missing section: ${section}`).toBe(true);
      }
    });
  });

  describe('specific key presence checks', () => {
    it('has app.title key', () => {
      expect(enTranslations['app.title']).toBeDefined();
      expect(koTranslations['app.title']).toBeDefined();
    });

    it('has settings.convert key', () => {
      expect(enTranslations['settings.convert']).toBeDefined();
      expect(koTranslations['settings.convert']).toBeDefined();
    });

    it('has format keys for GIF and WebP', () => {
      expect(enTranslations['format.gif']).toBeDefined();
      expect(koTranslations['format.gif']).toBeDefined();
      expect(enTranslations['format.webp']).toBeDefined();
      expect(koTranslations['format.webp']).toBeDefined();
    });

    it('has error.* keys', () => {
      const errorKeys = Object.keys(enTranslations).filter((k) => k.startsWith('error.'));
      expect(errorKeys.length).toBeGreaterThan(0);
      for (const key of errorKeys) {
        expect(koTranslations[key]).toBeDefined();
      }
    });

    it('has validation.* keys', () => {
      const validationKeys = Object.keys(enTranslations).filter((k) =>
        k.startsWith('validation.')
      );
      expect(validationKeys.length).toBeGreaterThan(0);
      for (const key of validationKeys) {
        expect(koTranslations[key]).toBeDefined();
      }
    });

    it('has progress.* keys', () => {
      const progressKeys = Object.keys(enTranslations).filter((k) =>
        k.startsWith('progress.')
      );
      expect(progressKeys.length).toBeGreaterThan(0);
      for (const key of progressKeys) {
        expect(koTranslations[key]).toBeDefined();
      }
    });

    it('has localized progress status and trim summary keys in every locale', () => {
      for (const translations of Object.values(allTranslations)) {
        expect(translations['progress.statusFrame']).toBeDefined();
        expect(translations['progress.statusFrameFps']).toBeDefined();
        expect(translations['trim.summary']).toBeDefined();
      }
    });
  });
});
