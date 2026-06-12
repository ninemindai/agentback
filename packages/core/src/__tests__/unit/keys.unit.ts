// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {BindingKey} from '@agentback/context';

import {CoreBindings, CoreTags} from '../../index.js';

describe('CoreBindings', () => {
  describe('APPLICATION_INSTANCE', () => {
    it('has correct key', () => {
      expect(CoreBindings.APPLICATION_INSTANCE.key).toBe(
        'application.instance',
      );
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.APPLICATION_INSTANCE).toBeInstanceOf(BindingKey);
    });
  });

  describe('APPLICATION_CONFIG', () => {
    it('has correct key', () => {
      expect(CoreBindings.APPLICATION_CONFIG.key).toBe('application.config');
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.APPLICATION_CONFIG).toBeInstanceOf(BindingKey);
    });
  });

  describe('APPLICATION_METADATA', () => {
    it('has correct key', () => {
      expect(CoreBindings.APPLICATION_METADATA.key).toBe(
        'application.metadata',
      );
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.APPLICATION_METADATA).toBeInstanceOf(BindingKey);
    });
  });

  describe('SERVERS', () => {
    it('has correct value', () => {
      expect(CoreBindings.SERVERS).toBe('servers');
    });

    it('is a string', () => {
      expect(CoreBindings.SERVERS).toBeTypeOf('string');
    });
  });

  describe('COMPONENTS', () => {
    it('has correct value', () => {
      expect(CoreBindings.COMPONENTS).toBe('components');
    });

    it('is a string', () => {
      expect(CoreBindings.COMPONENTS).toBeTypeOf('string');
    });
  });

  describe('CONTROLLERS', () => {
    it('has correct value', () => {
      expect(CoreBindings.CONTROLLERS).toBe('controllers');
    });

    it('is a string', () => {
      expect(CoreBindings.CONTROLLERS).toBeTypeOf('string');
    });
  });

  describe('CONTROLLER_CLASS', () => {
    it('has correct key', () => {
      expect(CoreBindings.CONTROLLER_CLASS.key).toBe('controller.current.ctor');
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.CONTROLLER_CLASS).toBeInstanceOf(BindingKey);
    });
  });

  describe('CONTROLLER_METHOD_NAME', () => {
    it('has correct key', () => {
      expect(CoreBindings.CONTROLLER_METHOD_NAME.key).toBe(
        'controller.current.operation',
      );
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.CONTROLLER_METHOD_NAME).toBeInstanceOf(BindingKey);
    });
  });

  describe('CONTROLLER_METHOD_META', () => {
    it('has correct value', () => {
      expect(CoreBindings.CONTROLLER_METHOD_META).toBe(
        'controller.method.meta',
      );
    });

    it('is a string', () => {
      expect(CoreBindings.CONTROLLER_METHOD_META).toBeTypeOf('string');
    });
  });

  describe('CONTROLLER_CURRENT', () => {
    it('has correct key', () => {
      expect(CoreBindings.CONTROLLER_CURRENT.key).toBe('controller.current');
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.CONTROLLER_CURRENT).toBeInstanceOf(BindingKey);
    });
  });

  describe('LIFE_CYCLE_OBSERVERS', () => {
    it('has correct value', () => {
      expect(CoreBindings.LIFE_CYCLE_OBSERVERS).toBe('lifeCycleObservers');
    });

    it('is a string', () => {
      expect(CoreBindings.LIFE_CYCLE_OBSERVERS).toBeTypeOf('string');
    });
  });

  describe('LIFE_CYCLE_OBSERVER_REGISTRY', () => {
    it('has correct key', () => {
      expect(CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY.key).toBe(
        'lifeCycleObserver.registry',
      );
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY).toBeInstanceOf(
        BindingKey,
      );
    });
  });

  describe('LIFE_CYCLE_OBSERVER_OPTIONS', () => {
    it('has correct key', () => {
      expect(CoreBindings.LIFE_CYCLE_OBSERVER_OPTIONS.key).toBe(
        'lifeCycleObserver.options',
      );
    });

    it('is a BindingKey', () => {
      expect(CoreBindings.LIFE_CYCLE_OBSERVER_OPTIONS).toBeInstanceOf(
        BindingKey,
      );
    });
  });

  describe('namespace consistency', () => {
    it('all binding keys are unique', () => {
      const keys = [
        CoreBindings.APPLICATION_INSTANCE.key,
        CoreBindings.APPLICATION_CONFIG.key,
        CoreBindings.APPLICATION_METADATA.key,
        CoreBindings.CONTROLLER_CLASS.key,
        CoreBindings.CONTROLLER_METHOD_NAME.key,
        CoreBindings.CONTROLLER_CURRENT.key,
        CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY.key,
        CoreBindings.LIFE_CYCLE_OBSERVER_OPTIONS.key,
      ];

      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('all string constants are unique', () => {
      const constants = [
        CoreBindings.SERVERS,
        CoreBindings.COMPONENTS,
        CoreBindings.CONTROLLERS,
        CoreBindings.CONTROLLER_METHOD_META,
        CoreBindings.LIFE_CYCLE_OBSERVERS,
      ];

      const uniqueConstants = new Set(constants);
      expect(uniqueConstants.size).toBe(constants.length);
    });
  });
});

describe('CoreTags', () => {
  describe('COMPONENT', () => {
    it('has correct value', () => {
      expect(CoreTags.COMPONENT).toBe('component');
    });

    it('is a string', () => {
      expect(CoreTags.COMPONENT).toBeTypeOf('string');
    });
  });

  describe('SERVER', () => {
    it('has correct value', () => {
      expect(CoreTags.SERVER).toBe('server');
    });

    it('is a string', () => {
      expect(CoreTags.SERVER).toBeTypeOf('string');
    });
  });

  describe('CONTROLLER', () => {
    it('has correct value', () => {
      expect(CoreTags.CONTROLLER).toBe('controller');
    });

    it('is a string', () => {
      expect(CoreTags.CONTROLLER).toBeTypeOf('string');
    });
  });

  describe('SERVICE', () => {
    it('has correct value', () => {
      expect(CoreTags.SERVICE).toBe('service');
    });

    it('is a string', () => {
      expect(CoreTags.SERVICE).toBeTypeOf('string');
    });
  });

  describe('SERVICE_INTERFACE', () => {
    it('has correct value', () => {
      expect(CoreTags.SERVICE_INTERFACE).toBe('serviceInterface');
    });

    it('is a string', () => {
      expect(CoreTags.SERVICE_INTERFACE).toBeTypeOf('string');
    });
  });

  describe('LIFE_CYCLE_OBSERVER', () => {
    it('has correct value', () => {
      expect(CoreTags.LIFE_CYCLE_OBSERVER).toBe('lifeCycleObserver');
    });

    it('is a string', () => {
      expect(CoreTags.LIFE_CYCLE_OBSERVER).toBeTypeOf('string');
    });
  });

  describe('LIFE_CYCLE_OBSERVER_GROUP', () => {
    it('has correct value', () => {
      expect(CoreTags.LIFE_CYCLE_OBSERVER_GROUP).toBe('lifeCycleObserverGroup');
    });

    it('is a string', () => {
      expect(CoreTags.LIFE_CYCLE_OBSERVER_GROUP).toBeTypeOf('string');
    });
  });

  describe('EXTENSION_FOR', () => {
    it('has correct value', () => {
      expect(CoreTags.EXTENSION_FOR).toBe('extensionFor');
    });

    it('is a string', () => {
      expect(CoreTags.EXTENSION_FOR).toBeTypeOf('string');
    });
  });

  describe('EXTENSION_POINT', () => {
    it('has correct value', () => {
      expect(CoreTags.EXTENSION_POINT).toBe('extensionPoint');
    });

    it('is a string', () => {
      expect(CoreTags.EXTENSION_POINT).toBeTypeOf('string');
    });
  });

  describe('tag uniqueness', () => {
    it('all tags are unique', () => {
      const tags = [
        CoreTags.COMPONENT,
        CoreTags.SERVER,
        CoreTags.CONTROLLER,
        CoreTags.SERVICE,
        CoreTags.SERVICE_INTERFACE,
        CoreTags.LIFE_CYCLE_OBSERVER,
        CoreTags.LIFE_CYCLE_OBSERVER_GROUP,
        CoreTags.EXTENSION_FOR,
        CoreTags.EXTENSION_POINT,
      ];

      const uniqueTags = new Set(tags);
      expect(uniqueTags.size).toBe(tags.length);
    });
  });

  describe('tag naming conventions', () => {
    it('uses camelCase for tag names', () => {
      const tags = [
        CoreTags.COMPONENT,
        CoreTags.SERVER,
        CoreTags.CONTROLLER,
        CoreTags.SERVICE,
        CoreTags.SERVICE_INTERFACE,
        CoreTags.LIFE_CYCLE_OBSERVER,
        CoreTags.LIFE_CYCLE_OBSERVER_GROUP,
        CoreTags.EXTENSION_FOR,
        CoreTags.EXTENSION_POINT,
      ];

      for (const tag of tags) {
        // Check that tag doesn't contain spaces or special characters
        expect(tag).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      }
    });
  });
});

describe('Keys and Tags Integration', () => {
  it('CoreBindings and CoreTags are separate namespaces', () => {
    // Ensure there's no overlap between binding keys and tags
    const bindingKeys = [
      CoreBindings.APPLICATION_INSTANCE.key,
      CoreBindings.APPLICATION_CONFIG.key,
      CoreBindings.APPLICATION_METADATA.key,
      CoreBindings.SERVERS,
      CoreBindings.COMPONENTS,
      CoreBindings.CONTROLLERS,
      CoreBindings.CONTROLLER_CLASS.key,
      CoreBindings.CONTROLLER_METHOD_NAME.key,
      CoreBindings.CONTROLLER_METHOD_META,
      CoreBindings.CONTROLLER_CURRENT.key,
      CoreBindings.LIFE_CYCLE_OBSERVERS,
      CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY.key,
      CoreBindings.LIFE_CYCLE_OBSERVER_OPTIONS.key,
    ];

    const tags = [
      CoreTags.COMPONENT,
      CoreTags.SERVER,
      CoreTags.CONTROLLER,
      CoreTags.SERVICE,
      CoreTags.SERVICE_INTERFACE,
      CoreTags.LIFE_CYCLE_OBSERVER,
      CoreTags.LIFE_CYCLE_OBSERVER_GROUP,
      CoreTags.EXTENSION_FOR,
      CoreTags.EXTENSION_POINT,
    ];

    // Tags and binding keys should be distinct
    const allValues = [...bindingKeys, ...tags];
    const uniqueValues = new Set(allValues);
    expect(uniqueValues.size).toBe(allValues.length);
  });

  it('related bindings and tags use consistent naming', () => {
    // Check that related concepts use similar naming
    expect(CoreBindings.SERVERS).toBe('servers');
    expect(CoreTags.SERVER).toBe('server');

    expect(CoreBindings.COMPONENTS).toBe('components');
    expect(CoreTags.COMPONENT).toBe('component');

    expect(CoreBindings.CONTROLLERS).toBe('controllers');
    expect(CoreTags.CONTROLLER).toBe('controller');

    expect(CoreBindings.LIFE_CYCLE_OBSERVERS).toBe('lifeCycleObservers');
    expect(CoreTags.LIFE_CYCLE_OBSERVER).toBe('lifeCycleObserver');
  });
});

// Made with Bob
