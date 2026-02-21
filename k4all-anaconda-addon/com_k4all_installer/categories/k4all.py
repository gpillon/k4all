# K4All Anaconda Addon - Category
# Copyright (C) 2024 K4All Project
# SPDX-License-Identifier: GPL-2.0-or-later

"""Category for K4All spoke in Anaconda."""

from pyanaconda.ui.categories import SpokeCategory

_ = lambda x: x
N_ = lambda x: x


class K4AllCategory(SpokeCategory):
    """Category for the K4All spoke.
    
    This category appears on the Anaconda hub and contains
    the K4All configuration spoke.
    """

    displayOnHubGUI = "SummaryHub"
    displayOnHubTUI = "SummaryHub"
    sortOrder = 100
    title = N_("K4ALL KUBERNETES")

