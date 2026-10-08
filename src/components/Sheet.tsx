import type {ReactNode} from 'react';
import {BottomSheet} from '@astryxdesign/core/BottomSheet';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {useMediaQuery} from '@astryxdesign/core/hooks';

/** Bottom sheet on phones, centered dialog on wide screens. */
export function Sheet({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const isDesktop = useMediaQuery('(min-width: 900px)');
  if (isDesktop) {
    return (
      <Dialog isOpen={isOpen} onOpenChange={open => !open && onClose()} purpose="form" width={480}>
        <DialogHeader title={title} />
        {children}
      </Dialog>
    );
  }
  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={open => !open && onClose()}
      label={title}
      purpose="form"
      height="hug"
      padding={4}>
      <VStack gap={4}>
        <Heading level={2}>{title}</Heading>
        {children}
      </VStack>
    </BottomSheet>
  );
}
