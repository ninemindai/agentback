// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {api, post} from '../../decorators/index.js';
import {getControllerSpec} from '../../controller-spec.js';
import {
  fileField,
  fileFieldsOf,
  isUploadedFile,
  type UploadedFile,
} from '../../file-field.js';

const aFile = (over: Partial<UploadedFile> = {}): UploadedFile => ({
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 1024,
  buffer: Buffer.from('x'),
  ...over,
});

describe('fileField — runtime validation', () => {
  it('accepts a well-formed uploaded file', () => {
    expect(fileField().safeParse(aFile()).success).toBe(true);
  });

  it('rejects a non-file value', () => {
    expect(fileField().safeParse({nope: true}).success).toBe(false);
    expect(isUploadedFile({nope: true})).toBe(false);
  });

  it('enforces maxSize', () => {
    const f = fileField({maxSize: 500});
    expect(f.safeParse(aFile({size: 400})).success).toBe(true);
    expect(f.safeParse(aFile({size: 600})).success).toBe(false);
  });

  it('enforces a mimeType allowlist', () => {
    const f = fileField({mimeTypes: ['image/png']});
    expect(f.safeParse(aFile({mimeType: 'image/png'})).success).toBe(true);
    expect(f.safeParse(aFile({mimeType: 'application/pdf'})).success).toBe(
      false,
    );
  });
});

describe('fileFieldsOf — body discovery', () => {
  it('finds file fields and their options on an object body', () => {
    const body = z.object({
      avatar: fileField({maxSize: 2048, mimeTypes: ['image/png']}),
      doc: fileField(),
      title: z.string(),
    });
    const found = fileFieldsOf(body);
    expect(found.map(f => f.name).sort()).toEqual(['avatar', 'doc']);
    const avatar = found.find(f => f.name === 'avatar')!;
    expect(avatar.options).toEqual({maxSize: 2048, mimeTypes: ['image/png']});
  });

  it('returns [] for a body with no file fields or a non-object', () => {
    expect(fileFieldsOf(z.object({title: z.string()}))).toEqual([]);
    expect(fileFieldsOf(z.string())).toEqual([]);
    expect(fileFieldsOf(undefined)).toEqual([]);
  });
});

describe('fileField — OpenAPI emission', () => {
  const Upload = z.object({
    file: fileField({description: 'the image'}),
    caption: z.string().optional(),
  });

  @api({basePath: '/photos'})
  class PhotoController {
    @post('/', {body: Upload})
    async create(_input: {body: z.infer<typeof Upload>}) {
      return {ok: true};
    }
  }

  const spec = getControllerSpec(PhotoController);
  const op = (Object.values(spec.paths!)[0] as Record<string, unknown>).post as {
    requestBody: {content: Record<string, {schema: Record<string, unknown>}>};
  };

  it('emits multipart/form-data (not application/json) for a fileField body', () => {
    expect(Object.keys(op.requestBody.content)).toEqual(['multipart/form-data']);
  });

  it('renders the file property as {type: string, format: binary}', () => {
    const props = op.requestBody.content['multipart/form-data'].schema
      .properties as Record<string, {type?: string; format?: string}>;
    expect(props.file.format).toBe('binary');
    expect(props.file.type).toBe('string');
    // non-file properties stay normal
    expect(props.caption.type).toBe('string');
    expect(props.caption.format).toBeUndefined();
  });
});

describe('non-file bodies still emit application/json', () => {
  const Plain = z.object({text: z.string()});

  @api({basePath: '/notes'})
  class NoteController {
    @post('/', {body: Plain})
    async create(_input: {body: z.infer<typeof Plain>}) {
      return {ok: true};
    }
  }

  it('keeps application/json when no fileField is present', () => {
    const spec = getControllerSpec(NoteController);
    const op = (Object.values(spec.paths!)[0] as Record<string, unknown>)
      .post as {requestBody: {content: Record<string, unknown>}};
    expect(Object.keys(op.requestBody.content)).toEqual(['application/json']);
  });
});
