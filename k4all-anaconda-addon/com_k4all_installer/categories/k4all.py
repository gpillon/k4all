# K4All Anaconda Addon - Category
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""Category for K4All spoke in Anaconda."""

import logging

from pyanaconda.ui.categories import SpokeCategory

__all__ = ["K4AllCategory"]

log = logging.getLogger(__name__)

_ = lambda x: x
N_ = lambda x: x


class K4AllCategory(SpokeCategory):
    """Category for the K4All spoke on the Anaconda hub."""

    @staticmethod
    def get_title():
        return _("K4ALL KUBERNETES")

    @staticmethod
    def get_sort_order():
        return 100


log.info("K4AllCategory loaded successfully")
